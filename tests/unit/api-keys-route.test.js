// /api/keys accepts, validates and reports per-key limits.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  getApiKeyById: vi.fn(),
  updateApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  sumApiKeyTokens: vi.fn(async () => 0),
}));

vi.mock("@/lib/localDb", async () => {
  const repo = await vi.importActual("@/lib/db/repos/apiKeysRepo.js");
  return { ...mocks, normalizeLimits: repo.normalizeLimits };
});
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: async () => "machine-1" }));

const { GET, POST } = await import("../../src/app/api/keys/route.js");
const { PUT } = await import("../../src/app/api/keys/[id]/route.js");

const post = (body) => new Request("http://localhost/api/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const put = (id, body) => PUT(
  new Request(`http://localhost/api/keys/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sumApiKeyTokens.mockResolvedValue(0);
});

describe("/api/keys", () => {
  it("GET adds period usage only to keys with a token budget", async () => {
    mocks.getApiKeys.mockResolvedValue([
      { id: "a", key: "sk-a", name: "plain", isActive: true, limits: null },
      { id: "b", key: "sk-b", name: "budget", isActive: true, limits: { tokenBudget: 1000, budgetPeriod: "daily" } },
    ]);
    mocks.sumApiKeyTokens.mockResolvedValue(250);
    const { keys } = await (await GET()).json();
    expect(keys[0].usage).toBeUndefined();
    expect(keys[1].usage.periodTokens).toBe(250);
    expect(typeof keys[1].usage.periodStart).toBe("string");
    expect(mocks.sumApiKeyTokens).toHaveBeenCalledTimes(1);
    expect(mocks.sumApiKeyTokens.mock.calls[0][0]).toBe("sk-b");
  });

  it("GET still returns every key when one usage query fails", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      mocks.getApiKeys.mockResolvedValue([
        { id: "a", key: "sk-a", name: "a", isActive: true, limits: { tokenBudget: 10, budgetPeriod: "lifetime" } },
        { id: "b", key: "sk-b", name: "b", isActive: true, limits: { tokenBudget: 10, budgetPeriod: "lifetime" } },
      ]);
      mocks.sumApiKeyTokens.mockImplementation(async (apiKey) => {
        if (apiKey === "sk-a") throw new Error("db down");
        return 7;
      });
      const res = await GET();
      expect(res.status).toBe(200);
      const { keys } = await res.json();
      expect(keys[0].usage).toBeNull();
      expect(keys[1].usage.periodTokens).toBe(7);
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("POST normalizes limits and passes them to createApiKey", async () => {
    mocks.createApiKey.mockResolvedValue({ id: "n", key: "sk-n", name: "x", machineId: "machine-1", limits: { rpm: 5 } });
    const res = await POST(post({ name: "x", limits: { rpm: "5", allowedModels: [] } }));
    expect(res.status).toBe(201);
    expect(mocks.createApiKey).toHaveBeenCalledWith("x", "machine-1", { allowedModels: [], rpm: 5, tpm: null, tokenBudget: null, budgetPeriod: "lifetime", expiresAt: null });
    expect((await res.json()).limits).toEqual({ rpm: 5 });
  });

  it("POST without limits still works (limits null)", async () => {
    mocks.createApiKey.mockResolvedValue({ id: "n", key: "sk-n", name: "x", machineId: "machine-1", limits: null });
    const res = await POST(post({ name: "x" }));
    expect(res.status).toBe(201);
    expect(mocks.createApiKey).toHaveBeenCalledWith("x", "machine-1", null);
  });

  it("POST rejects invalid limits with 400 and does not create", async () => {
    const res = await POST(post({ name: "x", limits: { rpm: -3 } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid rpm");
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });

  it("PUT updates name and limits, clears limits with null, rejects bad limits", async () => {
    mocks.getApiKeyById.mockResolvedValue({ id: "a", name: "old", isActive: true, limits: { rpm: 1 } });
    mocks.updateApiKey.mockImplementation(async (id, data) => ({ id, ...data }));

    let res = await put("a", { name: "new", limits: null });
    expect(res.status).toBe(200);
    expect(mocks.updateApiKey).toHaveBeenCalledWith("a", { name: "new", limits: null });

    res = await put("a", { isActive: false });
    expect(mocks.updateApiKey).toHaveBeenLastCalledWith("a", { isActive: false });

    res = await put("a", { limits: { budgetPeriod: "weekly" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid budgetPeriod");
  });
});
