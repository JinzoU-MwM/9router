import { describe, it, expect } from "vitest";
import { estimateInputTokens, estimateTextTokens } from "../../open-sse/utils/usageTracking.js";

// The estimator is only a FALLBACK: a provider-reported usage always wins
// (mergeUsage). It decides what the dashboard shows when an upstream reports no
// usage at all (streaming without a usage block, Cursor's non-standard path).
//
// It used to be chars/4, which assumes Latin prose. This gateway's payload is
// marker-heavy Indonesian (▓ ▒ ░ cost several tokens per glyph) plus logs, JSON
// and code. Measured against o200k_base over real request bodies, a flat chars/4
// was off by 21.9% mean absolute error and by 65% on marker-dense text; the
// ASCII/non-ASCII split brings that to 12.7% and 2.0%.
//
// These cases are the measured values, so a future "simplification" back to
// chars/4 fails here instead of silently skewing the numbers.
describe("estimateTextTokens", () => {
  it("returns 0 for empty or non-string input", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens(null)).toBe(0);
    expect(estimateTextTokens(undefined)).toBe(0);
    expect(estimateTextTokens(42)).toBe(0);
  });

  it("charges non-ASCII far more than ASCII", () => {
    const ascii = estimateTextTokens("a".repeat(400));
    const markers = estimateTextTokens("\u2593\u2592\u2591".repeat(133));
    // same character count, radically different token cost
    expect(markers).toBeGreaterThan(ascii * 3);
  });

  it("tracks marker-dense text (the persona payload shape)", () => {
    const markerHeavy = "\u2593\u2592\u2591 [RAKYAT] \u2591\u2592\u2593 \u2014 ".repeat(40);
    // measured: 760 chars -> 560 tokens (o200k_base)
    expect(estimateTextTokens(markerHeavy)).toBeGreaterThan(500);
    expect(estimateTextTokens(markerHeavy)).toBeLessThan(640);
  });

  it("tracks plain ASCII prose", () => {
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(21);
    // measured: 945 chars -> 210 tokens
    const est = estimateTextTokens(prose);
    expect(est).toBeGreaterThan(150);
    expect(est).toBeLessThan(260);
  });
});

describe("estimateInputTokens", () => {
  it("estimates a persona-bearing request close to the measured count", () => {
    // shape mirrors the injected body: one ~5 KB system prompt + a short turn
    const body = { messages: [
      { role: "system", content: "# PRESIDENSIAL\n" + "Aku RAKYAT JELATA, agent pelaksana. Presiden memerintah, aku jalankan. ".repeat(45) },
      { role: "user", content: "kerjakan X" },
    ] };
    const est = estimateInputTokens(body);
    expect(est).toBeGreaterThan(600);
    expect(est).toBeLessThan(1000);
  });

  it("never returns a negative or NaN estimate", () => {
    for (const body of [{}, { messages: [] }, { messages: [{ role: "user", content: "" }] }]) {
      const est = estimateInputTokens(body);
      expect(Number.isFinite(est)).toBe(true);
      expect(est).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns 0 for a body it cannot serialise", () => {
    const circular = {};
    circular.self = circular;
    expect(estimateInputTokens(circular)).toBe(0);
    expect(estimateInputTokens(null)).toBe(0);
  });
});
