import { describe, it, expect } from "vitest";
import { isPurgeableExhaustion, maskKey, hashKey } from "@/sse/services/bansosPurge.js";

// The policy gate for node-level auto-purge. Deleting a credential is the one
// irreversible action in the pool, so the "exhausted" boundary is pinned here:
// a shared free endpoint answers 429 as its normal state, and wiping the pool on
// a rate limit would be worse than the problem it solves.
describe("bansos auto-purge classification", () => {
  it("treats dead-credential statuses as exhaustion", () => {
    expect(isPurgeableExhaustion(401, "Invalid API key")).toBe(true);
    expect(isPurgeableExhaustion(402, "")).toBe(true);
  });

  it("never purges on rate limiting or transient failures", () => {
    expect(isPurgeableExhaustion(429, "Rate limit reached")).toBe(false);
    expect(isPurgeableExhaustion(429, "")).toBe(false);
    expect(isPurgeableExhaustion(503, "Service overloaded")).toBe(false);
    expect(isPurgeableExhaustion(0, "fetch failed")).toBe(false);
    expect(isPurgeableExhaustion(0, "connect ETIMEDOUT")).toBe(false);
    expect(isPurgeableExhaustion(500, "socket hang up")).toBe(false);
    // a quota word inside a rate-limit message is still transient
    expect(isPurgeableExhaustion(429, "quota exceeded, retry after 30s")).toBe(false);
  });

  it("only acts on a bare 403 when the body explains why", () => {
    expect(isPurgeableExhaustion(403, "")).toBe(false);
    expect(isPurgeableExhaustion(403, "Request forbidden by WAF")).toBe(false);
    expect(isPurgeableExhaustion(403, "Your API key has been disabled")).toBe(true);
  });

  it("recognises exhaustion spelled out in the body", () => {
    expect(isPurgeableExhaustion(400, "insufficient quota")).toBe(true);
    expect(isPurgeableExhaustion(200, "You exceeded your current quota, please check your plan")).toBe(true);
    expect(isPurgeableExhaustion(400, "Insufficient balance, please recharge")).toBe(true);
    expect(isPurgeableExhaustion(404, "model not found")).toBe(false);
  });

  it("keeps the archive non-reversible but auditable", () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz012345";
    const masked = maskKey(key);
    expect(masked).toContain("sk-abc");
    expect(masked).not.toContain("klmnopqrst");
    expect(maskKey("")).toBe(null);
    expect(hashKey(key)).toMatch(/^[0-9a-f]{16}$/);
    expect(hashKey(key)).toBe(hashKey(key));
    expect(hashKey(key)).not.toBe(hashKey(`${key}x`));
  });
});
