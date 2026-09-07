import { describe, it, expect } from "vitest";
import { isFreeModel } from "@/shared/utils/freeModel.js";

describe("isFreeModel", () => {
  it("detects OpenRouter free suffix", () => {
    expect(isFreeModel({ id: "deepseek/deepseek-r1:free" })).toBe(true);
    expect(isFreeModel({ id: "z-ai/glm-4.5-air-free" })).toBe(true);
  });

  it("does not treat 'free' inside a word as a free tier", () => {
    expect(isFreeModel({ id: "somelab/freeform-v2" })).toBe(null);
  });

  it("reads zero string pricing (OpenRouter/chutes shape)", () => {
    expect(isFreeModel({ id: "a/b", pricing: { prompt: "0", completion: "0" } })).toBe(true);
    expect(isFreeModel({ id: "a/b", pricing: { prompt: "0.0000004", completion: "0.0000016" } })).toBe(false);
  });

  it("marks paid when only one side costs money", () => {
    expect(isFreeModel({ id: "a/b", pricing: { prompt: "0", completion: "0.000002" } })).toBe(false);
  });

  it("reads flat per-token cost fields (LiteLLM shape)", () => {
    expect(isFreeModel({ id: "a/b", input_cost_per_token: 0, output_cost_per_token: 0 })).toBe(true);
    expect(isFreeModel({ id: "a/b", input_cost_per_token: 0, output_cost_per_token: 3e-7 })).toBe(false);
  });

  it("ignores non-token surcharges", () => {
    expect(isFreeModel({ id: "a/b", pricing: { prompt: "0", completion: "0", image: "0.001", request: "0.002" } })).toBe(true);
  });

  it("returns null when the provider sends no pricing at all", () => {
    expect(isFreeModel({ id: "gpt-4o", object: "model" })).toBe(null);
    expect(isFreeModel({ id: "a/b", pricing: { prompt: "", completion: null } })).toBe(null);
  });

  it("falls back to name/model fields for the id", () => {
    expect(isFreeModel({ name: "qwen/qwen3-coder:free" })).toBe(true);
    expect(isFreeModel({ model: "qwen/qwen3-coder:free" })).toBe(true);
    expect(isFreeModel({})).toBe(null);
  });
});
