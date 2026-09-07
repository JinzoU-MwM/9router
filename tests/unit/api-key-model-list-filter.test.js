// filterModelsForApiKey: /v1/models listing must honour the key's allowedModels.
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

const { filterModelsForApiKey } = await import("../../src/sse/services/auth.js");

const req = (key) => new Request("http://localhost/v1/models", {
  headers: key ? { Authorization: `Bearer ${key}` } : {},
});
const MODELS = [
  { id: "openai/gpt-4o" },
  { id: "openai/gpt-4o-mini" },
  { id: "gemini/gemini-2.5-pro" },
];
const row = (allowedModels) => ({
  id: "k1", key: "sk-k1", isActive: true,
  limits: { allowedModels, rpm: null, tpm: null, tokenBudget: null, budgetPeriod: "lifetime", expiresAt: null },
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getApiKeyByKey.mockResolvedValue(null);
});

describe("filterModelsForApiKey", () => {
  it("keeps only the allowed models, glob included", async () => {
    dbMocks.getApiKeyByKey.mockResolvedValue(row(["openai/gpt-4o*"]));
    expect(await filterModelsForApiKey(req("sk-k1"), MODELS)).toEqual([
      { id: "openai/gpt-4o" },
      { id: "openai/gpt-4o-mini" },
    ]);
  });

  it("exact allowlist entry does not match siblings", async () => {
    dbMocks.getApiKeyByKey.mockResolvedValue(row(["openai/gpt-4o"]));
    expect(await filterModelsForApiKey(req("sk-k1"), MODELS)).toEqual([{ id: "openai/gpt-4o" }]);
  });

  it("passes the list through with no key, unknown key, or empty allowlist", async () => {
    expect(await filterModelsForApiKey(req(null), MODELS)).toEqual(MODELS);
    expect(await filterModelsForApiKey(req("sk-unknown"), MODELS)).toEqual(MODELS);
    dbMocks.getApiKeyByKey.mockResolvedValue(row([]));
    expect(await filterModelsForApiKey(req("sk-k1"), MODELS)).toEqual(MODELS);
  });
});
