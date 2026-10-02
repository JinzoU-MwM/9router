import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9r-sweep-"));
process.env.DATA_DIR = DIR;

const { classifyProbe, shouldProbe, LIVE_RECHECK_MS, COOLDOWN_RECHECK_MS } = await import("@/lib/bansosSweep.js");

// The sweeper decides who lives and who dies in a pool, so its two decisions are
// pinned here: what a probe result means, and when a key is due again.
describe("bansos sweep decisions", () => {
  it("reads a probe result as live / cooldown / exhausted", () => {
    expect(classifyProbe({ ok: true, status: 200, errorText: "" })).toBe("live");
    expect(classifyProbe({ ok: false, status: 401, errorText: "Invalid API key" })).toBe("exhausted");
    expect(classifyProbe({ ok: false, status: 402, errorText: "insufficient balance" })).toBe("exhausted");
    // a shared free relay answers 429 as its normal state — keep it
    expect(classifyProbe({ ok: false, status: 429, errorText: "Rate limit reached" })).toBe("cooldown");
    expect(classifyProbe({ ok: false, status: 500, errorText: "internal error" })).toBe("cooldown");
    expect(classifyProbe({ ok: false, status: 0, errorText: "probe timeout" })).toBe("cooldown");
    // bare 403 is a WAF/geo-block as often as it is a dead key
    expect(classifyProbe({ ok: false, status: 403, errorText: "" })).toBe("cooldown");
  });

  it("probes a key that was never checked, and honours the recheck window", () => {
    const now = Date.parse("2026-10-02T10:00:00Z");
    expect(shouldProbe({}, now)).toBe(true);
    expect(shouldProbe({ bansosState: { state: "live", lastCheckedAt: new Date(now - 1000).toISOString() } }, now)).toBe(false);
    expect(shouldProbe({ bansosState: { state: "live", lastCheckedAt: new Date(now - LIVE_RECHECK_MS - 1000).toISOString() } }, now)).toBe(true);
    expect(shouldProbe({ bansosState: { state: "cooldown", lastCheckedAt: new Date(now - COOLDOWN_RECHECK_MS - 1000).toISOString() } }, now)).toBe(true);
    // an explicit future recheck wins over the age rule
    expect(shouldProbe({
      bansosState: { state: "dead", lastCheckedAt: new Date(now - 30 * 24 * 3600e3).toISOString(), recheckAt: new Date(now + 60000).toISOString() },
    }, now)).toBe(false);
  });
});
