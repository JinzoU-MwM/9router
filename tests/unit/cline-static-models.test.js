// `cline.js` models[] is the STATIC FALLBACK shown when the live catalog fetch
// (resolveClineModels → api.cline.bot/api/v1/models) fails. A dead id here means
// the picker offers a model the gateway will reject, so the list must track the
// live catalog. Every id below was verified against the live endpoint; this test
// locks the shape and the ids that were wrong before.
import { describe, it, expect } from "vitest";
import cline from "../../open-sse/providers/registry/cline.js";

describe("cline static fallback catalog", () => {
  const ids = cline.models.map((m) => m.id);

  it("has no duplicate model ids", () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every entry a non-empty id and display name", () => {
    for (const m of cline.models) {
      expect(typeof m.id).toBe("string");
      expect(m.id.trim()).not.toBe("");
      expect(typeof m.name).toBe("string");
      expect(m.name.trim()).not.toBe("");
    }
  });

  it("includes the full live muse-spark family, contributors included", () => {
    for (const id of [
      "meta/muse-spark-1.1",
      "meta/muse-spark-1.2",
      "meta/muse-spark-1.2-contributor",
      "meta/muse-spark-1.3",
      "meta/muse-spark-1.3-contributor",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("does not reference the retired bare kat-coder-pro id", () => {
    // api.cline.bot now serves only the -v2 / -v2.5 variants.
    expect(ids).not.toContain("kwaipilot/kat-coder-pro");
    expect(ids).toContain("kwaipilot/kat-coder-pro-v2.5");
  });
});
