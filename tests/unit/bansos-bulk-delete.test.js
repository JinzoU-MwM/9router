import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9r-bulk-"));
process.env.DATA_DIR = DIR;

let repo, node;

beforeAll(async () => {
  repo = await import("@/lib/db/repos/connectionsRepo.js");
  const { createProviderNode } = await import("@/lib/db/repos/nodesRepo.js");
  node = await createProviderNode({ type: "openai-compatible", name: "Pool", prefix: "pool", apiType: "chat", baseUrl: "http://x/v1" });
});

async function seed(n) {
  for (const c of await repo.getProviderConnections({ provider: node.id })) {
    await repo.deleteProviderConnection(c.id);
  }
  for (let i = 0; i < n; i++) {
    await repo.createProviderConnection({ provider: node.id, authType: "apikey", name: `k${i}`, data: { apiKey: `sk-${i}` } });
  }
  return repo.getProviderConnections({ provider: node.id });
}

// The single-id delete reorders the whole pool after every row (O(pool) each).
// A sweep retiring dead keys needs the bulk path, and the pool must still come
// out contiguous — priority is what the UI reorder buttons and fill-first
// selection rely on.
describe("bulk connection delete", () => {
  it("removes many rows and reorders the pool once, leaving priorities contiguous", async () => {
    const all = await seed(12);
    expect(all.length).toBe(12);

    const victims = [all[1].id, all[4].id, all[7].id, all[11].id];
    const removed = await repo.deleteProviderConnections(victims);
    expect(removed).toBe(4);

    const left = await repo.getProviderConnections({ provider: node.id });
    expect(left.length).toBe(8);
    expect(left.map((c) => c.priority)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(left.map((c) => c.name)).toEqual(["k0", "k2", "k3", "k5", "k6", "k8", "k9", "k10"]);
  });

  it("ignores unknown ids and de-duplicates the input", async () => {
    const all = await seed(5);
    const removed = await repo.deleteProviderConnections([all[0].id, all[0].id, "does-not-exist"]);
    expect(removed).toBe(1);
    expect((await repo.getProviderConnections({ provider: node.id })).length).toBe(4);
  });

  it("is a no-op for an empty list", async () => {
    await seed(3);
    expect(await repo.deleteProviderConnections([])).toBe(0);
    expect(await repo.deleteProviderConnections(null)).toBe(0);
    expect((await repo.getProviderConnections({ provider: node.id })).length).toBe(3);
  });
});
