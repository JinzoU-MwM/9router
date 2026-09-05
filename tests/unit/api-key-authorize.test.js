// authorizeApiKey: settings + key lookup + checkKeyLimits → Response|null.
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getApiKeyByKey: vi.fn(),
  sumApiKeyTokens: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  validateApiKey: vi.fn(),
  getProxyPools: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({ pickProxyPoolId: vi.fn(), resolveConnectionProxyConfig: vi.fn() }));
vi.mock("@/shared/constants/providers.js", () => ({ FREE_PROVIDERS: {}, resolveProviderId: (p) => p }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), maskKey: (k) => k }));

const { authorizeApiKey } = await import("../../src/sse/services/auth.js");
const { _resetRpmStore } = await import("../../src/sse/services/keyLimits.js");

const row = (over = {}) => ({ id: "k1", key: "sk-k1", name: "k1", isActive: true, limits: null, ...over });
const lim = (over) => ({ allowedModels: [], rpm: null, tpm: null, tokenBudget: null, budgetPeriod: "lifetime", expiresAt: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  _resetRpmStore();
  dbMocks.sumApiKeyTokens.mockResolvedValue(0);
  dbMocks.getApiKeyByKey.mockResolvedValue(null);
});

describe("authorizeApiKey", () => {
  it("no key: passes when requireApiKey is off, 401 when on", async () => {
    dbMocks.getSettings.mockResolvedValue({ requireApiKey: false });
    expect(await authorizeApiKey(null, { model: "m" })).toBeNull();

    dbMocks.getSettings.mockResolvedValue({ requireApiKey: true });
    const res = await authorizeApiKey(null, { model: "m" });
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe("Missing API key");
  });

  it("unknown key: passes when requireApiKey is off, 401 when on", async () => {
    dbMocks.getSettings.mockResolvedValue({ requireApiKey: false });
    expect(await authorizeApiKey("sk-unknown", { model: "m" })).toBeNull();

    dbMocks.getSettings.mockResolvedValue({ requireApiKey: true });
    const res = await authorizeApiKey("sk-unknown", { model: "m" });
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toBe("Invalid API key");
  });

  it("known key without limits passes and never queries usage", async () => {
    dbMocks.getSettings.mockResolvedValue({ requireApiKey: true });
    dbMocks.getApiKeyByKey.mockResolvedValue(row());
    expect(await authorizeApiKey("sk-k1", { model: "m" })).toBeNull();
    expect(dbMocks.sumApiKeyTokens).not.toHaveBeenCalled();
  });

  it("blocks a paused known key even when requireApiKey is off", async () => {
    dbMocks.getSettings.mockResolvedValue({ requireApiKey: false });
    dbMocks.getApiKeyByKey.mockResolvedValue(row({ isActive: false }));
    const res = await authorizeApiKey("sk-k1", { model: "m" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a model outside the allowlist", async () => {
    dbMocks.getSettings.mockResolvedValue({ requireApiKey: false });
    dbMocks.getApiKeyByKey.mockResolvedValue(row({ limits: lim({ allowedModels: ["openai/*"] }) }));
    const res = await authorizeApiKey("sk-k1", { model: "claude-x" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe("Model not allowed for this API key");
  });

  it("returns 429 with Retry-After when the daily budget is exhausted", async () => {
    dbMocks.getSettings.mockResolvedValue({ requireApiKey: false });
    dbMocks.getApiKeyByKey.mockResolvedValue(row({ limits: lim({ tokenBudget: 100, budgetPeriod: "daily" }) }));
    dbMocks.sumApiKeyTokens.mockResolvedValue(100);
    const res = await authorizeApiKey("sk-k1", { model: "m" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await res.json()).error.message).toContain("Token budget exhausted");
    expect(dbMocks.sumApiKeyTokens).toHaveBeenCalledWith("sk-k1", expect.any(String));
  });

  it("returns 429 without Retry-After when a lifetime budget is exhausted", async () => {
    dbMocks.getSettings.mockResolvedValue({ requireApiKey: false });
    dbMocks.getApiKeyByKey.mockResolvedValue(row({ limits: lim({ tokenBudget: 100 }) }));
    dbMocks.sumApiKeyTokens.mockResolvedValue(150);
    const res = await authorizeApiKey("sk-k1", { model: "m" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});
