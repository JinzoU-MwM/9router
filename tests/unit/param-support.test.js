import { describe, it, expect } from "vitest";

import { stripUnsupportedParams, normalizeMaxTokensField } from "../../open-sse/translator/concerns/paramSupport.js";

describe("stripUnsupportedParams", () => {
  it("flattens Cloudflare AI OpenAI content-part arrays", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
            { type: "text", text: "world" },
          ],
        },
      ],
    };

    expect(() => stripUnsupportedParams("cloudflare-ai", "@cf/meta/llama-3.1-8b-instruct", body)).not.toThrow();
    expect(body.messages[0].content).toBe("hello world");
  });

  it("still drops unsupported GitHub model params", () => {
    const body = { temperature: 0.7, top_p: 1 };

    stripUnsupportedParams("github", "gpt-5.4", body);

    expect(body).toEqual({ top_p: 1 });
  });

  it("clamps VolcEngine Ark GLM max token fields to the model output ceiling", () => {
    const body = {
      max_tokens: 131072,
      max_completion_tokens: 131072,
      max_output_tokens: 131072,
    };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body).toEqual({
      max_tokens: 128000,
      max_completion_tokens: 128000,
      max_output_tokens: 128000,
    });
  });

  it("keeps VolcEngine Ark GLM max tokens when already under the ceiling", () => {
    const body = { max_tokens: 64000 };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body.max_tokens).toBe(64000);
  });

  it("drops replayed reasoning fields from assistant messages for strict providers", () => {
    const makeBody = () => ({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "hello",
          reasoning_content: "thinking...",
          reasoning: "thinking...",
          reasoning_details: [{ text: "thinking..." }],
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "user", content: "again", reasoning_content: "user-side field stays" },
      ],
    });

    for (const [provider, model] of [
      ["groq", "openai/gpt-oss-120b"],
      ["mistral", "codestral-latest"],
      ["cerebras", "gpt-oss-120b"],
    ]) {
      const body = makeBody();
      stripUnsupportedParams(provider, model, body);
      expect(body.messages[1]).toEqual({
        role: "assistant",
        content: "hello",
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      });
      // only assistant turns are touched
      expect(body.messages[2].reasoning_content).toBe("user-side field stays");
    }
  });

  it("leaves reasoning fields alone for providers that accept or require them", () => {
    const body = {
      messages: [{ role: "assistant", content: "hello", reasoning_content: "thinking..." }],
    };

    stripUnsupportedParams("deepseek", "deepseek-reasoner", body);
    stripUnsupportedParams("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free", body);

    expect(body.messages[0].reasoning_content).toBe("thinking...");
  });
});

describe("normalizeMaxTokensField", () => {
  const PROVIDER = "openai-compatible-chat-492eb97c-f3ff-48ae-b46d-5a68c05bbff6";

  it("translates max_completion_tokens to max_tokens for openai-compatible nodes", () => {
    const body = { max_completion_tokens: 1024 };

    normalizeMaxTokensField(PROVIDER, "qwen35-9b-fast:latest", body, null);

    expect(body.max_tokens).toBe(1024);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("keeps max_tokens when the client already sent it and drops the sibling", () => {
    const body = { max_tokens: 4096, max_completion_tokens: 1024 };

    normalizeMaxTokensField(PROVIDER, "qwen35-9b-fast:latest", body, null);

    expect(body.max_tokens).toBe(4096);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("honours the per-node maxTokensField opt-out", () => {
    const body = { max_tokens: 2048 };
    const credentials = { providerSpecificData: { maxTokensField: "max_completion_tokens" } };

    normalizeMaxTokensField(PROVIDER, "gpt-5.6-sol", body, credentials);

    expect(body.max_completion_tokens).toBe(2048);
    expect(body.max_tokens).toBeUndefined();
  });

  it("clamps the translated field to the model output ceiling", () => {
    const body = { max_completion_tokens: 500000 };

    normalizeMaxTokensField(PROVIDER, "qwen35-9b-fast:latest", body, null);

    expect(body.max_tokens).toBe(64000);
  });

  it("leaves non-compatible providers untouched", () => {
    const body = { max_completion_tokens: 1024 };

    normalizeMaxTokensField("openai", "gpt-5.6-sol", body, null);

    expect(body).toEqual({ max_completion_tokens: 1024 });
  });
});
