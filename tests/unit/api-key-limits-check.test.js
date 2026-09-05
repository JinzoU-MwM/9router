// Pure per-key limit helpers: no DB, sumTokens injected.
import { describe, it, expect, beforeEach } from "vitest";
import {
  modelMatches, expiresAtMs, checkRpm, recordRpmHit, _resetRpmStore,
  periodStart, periodEnd, checkKeyLimits,
} from "@/sse/services/keyLimits.js";

const T0 = new Date(2026, 8, 5, 12, 0, 0).getTime(); // 2026-09-05 12:00 local
const iso = (ms) => new Date(ms).toISOString();
const key = (limits, extra = {}) => ({ id: "k1", key: "sk-k1", name: "k1", isActive: true, limits, ...extra });
const lim = (over) => ({ allowedModels: [], rpm: null, tpm: null, tokenBudget: null, budgetPeriod: "lifetime", expiresAt: null, ...over });
const zero = async () => 0;

describe("modelMatches", () => {
  it("allows everything when no patterns or no model", () => {
    expect(modelMatches("gpt-4o", [])).toBe(true);
    expect(modelMatches("gpt-4o", undefined)).toBe(true);
    expect(modelMatches(null, ["openai/*"])).toBe(true);
  });
  it("matches exact names and * globs, case-sensitive, full string", () => {
    expect(modelMatches("openai/gpt-4o", ["openai/*"])).toBe(true);
    expect(modelMatches("claude-sonnet-4", ["claude-*"])).toBe(true);
    expect(modelMatches("my-combo", ["my-combo"])).toBe(true);
    expect(modelMatches("openai/gpt-4o", ["gpt-4o"])).toBe(false);
    expect(modelMatches("OpenAI/gpt-4o", ["openai/*"])).toBe(false);
    expect(modelMatches("gpt-4o.1", ["gpt-4o.*"])).toBe(true);
    expect(modelMatches("gpt-4oX1", ["gpt-4o.*"])).toBe(false); // "." is literal
  });
});

describe("expiresAtMs", () => {
  it("date-only expires at the end of that local day", () => {
    expect(expiresAtMs("2026-09-05")).toBe(new Date(2026, 8, 6).getTime());
  });
  it("full timestamps are used as-is; empty or garbage is null", () => {
    expect(expiresAtMs("2026-09-05T10:00:00.000Z")).toBe(Date.parse("2026-09-05T10:00:00.000Z"));
    expect(expiresAtMs(null)).toBeNull();
    expect(expiresAtMs("nope")).toBeNull();
  });
});

describe("checkRpm", () => {
  beforeEach(() => _resetRpmStore());
  it("allows rpm hits per 60s window then refuses with a retry hint", () => {
    recordRpmHit("k1", T0);
    recordRpmHit("k1", T0 + 1000);
    expect(checkRpm("k1", 3, T0 + 2000).allowed).toBe(true);
    recordRpmHit("k1", T0 + 2000);
    const r = checkRpm("k1", 3, T0 + 3000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(57_000);
    expect(checkRpm("k1", 3, T0 + 60_001).allowed).toBe(true);
    expect(checkRpm("other", 1, T0).allowed).toBe(true);
  });
});

describe("periodStart / periodEnd", () => {
  it("lifetime starts at epoch and never ends", () => {
    expect(periodStart("lifetime", T0)).toBe("1970-01-01T00:00:00.000Z");
    expect(periodEnd("lifetime", T0)).toBeNull();
  });
  it("daily and monthly use local calendar boundaries", () => {
    expect(periodStart("daily", T0)).toBe(new Date(2026, 8, 5).toISOString());
    expect(periodEnd("daily", T0)).toBe(new Date(2026, 8, 6).toISOString());
    expect(periodStart("monthly", T0)).toBe(new Date(2026, 8, 1).toISOString());
    expect(periodEnd("monthly", T0)).toBe(new Date(2026, 9, 1).toISOString());
  });
});

describe("checkKeyLimits", () => {
  beforeEach(() => _resetRpmStore());

  it("passes active keys without limits and never calls sumTokens", async () => {
    let calls = 0;
    const sumTokens = async () => { calls++; return 0; };
    expect(await checkKeyLimits(key(null), { model: "x", now: T0, sumTokens })).toBeNull();
    expect(calls).toBe(0);
  });

  it("refuses paused keys", async () => {
    expect(await checkKeyLimits(key(null, { isActive: false }), { model: "x", now: T0, sumTokens: zero }))
      .toEqual({ status: 401, message: "Invalid API key", retryAfterMs: null });
  });

  it("refuses expired keys, date-only valid through end of day", async () => {
    expect(await checkKeyLimits(key(lim({ expiresAt: "2026-09-04" })), { model: "x", now: T0, sumTokens: zero }))
      .toEqual({ status: 401, message: "API key expired", retryAfterMs: null });
    expect(await checkKeyLimits(key(lim({ expiresAt: "2026-09-05" })), { model: "x", now: T0, sumTokens: zero })).toBeNull();
  });

  it("refuses models outside the allowlist", async () => {
    const k = key(lim({ allowedModels: ["openai/*"] }));
    expect(await checkKeyLimits(k, { model: "claude-x", now: T0, sumTokens: zero }))
      .toEqual({ status: 403, message: "Model not allowed for this API key", retryAfterMs: null });
    expect(await checkKeyLimits(k, { model: "openai/gpt-4o", now: T0, sumTokens: zero })).toBeNull();
  });

  it("enforces rpm and records a hit only when the request passes", async () => {
    const k = key(lim({ rpm: 2 }));
    expect(await checkKeyLimits(k, { model: "m", now: T0, sumTokens: zero })).toBeNull();
    expect(await checkKeyLimits(k, { model: "m", now: T0 + 1, sumTokens: zero })).toBeNull();
    const r = await checkKeyLimits(k, { model: "m", now: T0 + 2, sumTokens: zero });
    expect(r.status).toBe(429);
    expect(r.message).toBe("Rate limit exceeded (rpm)");
    expect(r.retryAfterMs).toBeGreaterThan(0);
    // a refused request must not consume a slot
    expect(await checkKeyLimits(k, { model: "m", now: T0 + 60_000, sumTokens: zero })).toBeNull();
  });

  it("enforces tpm over the last 60 seconds", async () => {
    const seen = [];
    const sumTokens = async (apiKey, since) => { seen.push([apiKey, since]); return 1000; };
    const r = await checkKeyLimits(key(lim({ tpm: 1000 })), { model: "m", now: T0, sumTokens });
    expect(r).toEqual({ status: 429, message: "Rate limit exceeded (tpm)", retryAfterMs: 60_000 });
    expect(seen).toEqual([["sk-k1", iso(T0 - 60_000)]]);
  });

  it("enforces the budget with a period-end retry hint", async () => {
    const seen = [];
    const sumTokens = async (apiKey, since) => { seen.push(since); return 500; };
    const daily = await checkKeyLimits(key(lim({ tokenBudget: 500, budgetPeriod: "daily" })), { model: "m", now: T0, sumTokens });
    expect(daily).toEqual({ status: 429, message: "Token budget exhausted", retryAfterMs: new Date(2026, 8, 6).getTime() - T0 });
    expect(seen).toEqual([new Date(2026, 8, 5).toISOString()]);

    const lifetime = await checkKeyLimits(key(lim({ tokenBudget: 500 })), { model: "m", now: T0, sumTokens });
    expect(lifetime).toEqual({ status: 429, message: "Token budget exhausted", retryAfterMs: null });

    const under = await checkKeyLimits(key(lim({ tokenBudget: 501 })), { model: "m", now: T0, sumTokens });
    expect(under).toBeNull();
  });

  it("does not let concurrent requests slip past rpm while awaiting usage", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const sumTokens = async () => { await gate; return 0; };
    const k = key(lim({ rpm: 1, tpm: 1000 }));
    const p1 = checkKeyLimits(k, { model: "m", now: T0, sumTokens });
    const p2 = checkKeyLimits(k, { model: "m", now: T0, sumTokens });
    release();
    const results = await Promise.all([p1, p2]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r?.status === 429 && r.message === "Rate limit exceeded (rpm)")).toHaveLength(1);
  });
});
