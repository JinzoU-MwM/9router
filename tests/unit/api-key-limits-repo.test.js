// Per-key limits: normalizeLimits + apiKeys repo storage + export/import round trip.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-key-limits-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("normalizeLimits", () => {
  it("returns null when everything is empty", () => {
    expect(db.normalizeLimits(null)).toBeNull();
    expect(db.normalizeLimits(undefined)).toBeNull();
    expect(db.normalizeLimits({})).toBeNull();
    expect(db.normalizeLimits({ rpm: "", tpm: 0, allowedModels: [], expiresAt: "" })).toBeNull();
  });

  it("coerces numbers, trims and de-duplicates model patterns", () => {
    expect(db.normalizeLimits({ rpm: "60", tpm: 0, tokenBudget: 5e6, allowedModels: [" openai/* ", "openai/*", "x", ""] }))
      .toEqual({ allowedModels: ["openai/*", "x"], rpm: 60, tpm: null, tokenBudget: 5000000, budgetPeriod: "lifetime", expiresAt: null });
    expect(db.normalizeLimits({ tokenBudget: 10, budgetPeriod: "daily", expiresAt: "2030-01-31" }))
      .toEqual({ allowedModels: [], rpm: null, tpm: null, tokenBudget: 10, budgetPeriod: "daily", expiresAt: "2030-01-31" });
  });

  it("rejects bad input with a field-specific message", () => {
    expect(() => db.normalizeLimits({ rpm: -1 })).toThrow("Invalid rpm");
    expect(() => db.normalizeLimits({ rpm: 1.5 })).toThrow("Invalid rpm");
    expect(() => db.normalizeLimits({ tpm: "abc" })).toThrow("Invalid tpm");
    expect(() => db.normalizeLimits({ budgetPeriod: "weekly" })).toThrow("Invalid budgetPeriod");
    expect(() => db.normalizeLimits({ expiresAt: "not-a-date" })).toThrow("Invalid expiresAt");
    expect(() => db.normalizeLimits({ allowedModels: "openai/*" })).toThrow("Invalid allowedModels");
    expect(() => db.normalizeLimits([])).toThrow("Invalid limits");
  });
});

describe("apiKeys repo with limits", () => {
  it("stores, reads back, updates and clears limits", async () => {
    const limits = { allowedModels: ["openai/*"], rpm: 10, tpm: null, tokenBudget: 1000, budgetPeriod: "daily", expiresAt: "2030-01-01" };
    const k = await db.createApiKey("limited", "machine-1", limits);
    expect(k.limits).toEqual(limits);

    const byKey = await db.getApiKeyByKey(k.key);
    expect(byKey.id).toBe(k.id);
    expect(byKey.isActive).toBe(true);
    expect(byKey.limits).toEqual(limits);
    expect(await db.getApiKeyByKey("nope")).toBeNull();

    const updated = await db.updateApiKey(k.id, { limits: { ...limits, rpm: 20 } });
    expect(updated.limits.rpm).toBe(20);
    expect((await db.getApiKeyById(k.id)).limits.rpm).toBe(20);

    // Unrelated update keeps limits
    await db.updateApiKey(k.id, { isActive: false });
    expect((await db.getApiKeyById(k.id)).limits.rpm).toBe(20);

    await db.updateApiKey(k.id, { limits: null });
    expect((await db.getApiKeyById(k.id)).limits).toBeNull();
  });

  it("keeps limits null for plain keys and survives export/import", async () => {
    const plain = await db.createApiKey("plain", "machine-1");
    expect(plain.limits).toBeNull();
    const limited = await db.createApiKey("limited2", "machine-1", { allowedModels: [], rpm: 5, tpm: null, tokenBudget: null, budgetPeriod: "lifetime", expiresAt: null });

    const dump = await db.exportDb();
    expect(dump.apiKeys.find((x) => x.id === limited.id).limits.rpm).toBe(5);
    expect(dump.apiKeys.find((x) => x.id === plain.id).limits).toBeNull();

    await db.importDb(dump);
    expect((await db.getApiKeyById(limited.id)).limits.rpm).toBe(5);
    expect((await db.getApiKeyById(plain.id)).limits).toBeNull();
  });
});

describe("sumApiKeyTokens", () => {
  it("sums prompt+completion tokens for one key since a timestamp", async () => {
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    await db.saveRequestUsage({ provider: "openai", model: "gpt-x", apiKey: "sk-sum-a", timestamp: iso(now - 120_000), tokens: { prompt_tokens: 100, completion_tokens: 50 } });
    await db.saveRequestUsage({ provider: "openai", model: "gpt-x", apiKey: "sk-sum-a", timestamp: iso(now - 10_000), tokens: { prompt_tokens: 10, completion_tokens: 5 } });
    await db.saveRequestUsage({ provider: "openai", model: "gpt-x", apiKey: "sk-sum-b", timestamp: iso(now - 10_000), tokens: { prompt_tokens: 999, completion_tokens: 1 } });

    expect(await db.sumApiKeyTokens("sk-sum-a", iso(0))).toBe(165);
    expect(await db.sumApiKeyTokens("sk-sum-a", iso(now - 60_000))).toBe(15);
    expect(await db.sumApiKeyTokens("sk-sum-none", iso(0))).toBe(0);
  });
});
