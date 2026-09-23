// The CN executor used to silently rewrite the caller's system prompt whenever it
// looked like an agent prompt (identity regex) or exceeded 2000 chars, replacing
// it with "You are a helpful AI assistant...". That is a lossy workaround for
// Tencent's content filter: it changes agent behavior and hides the real failure.
// It is now opt-in per connection via
//   providerSpecificData: { neutralizeAgentPrompt: true }
// Default behavior must preserve the caller's system prompt verbatim.
import { describe, it, expect } from "vitest";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";

const NEUTRAL = "You are a helpful AI assistant that helps with software engineering tasks.";
const AGENT_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
const LONG_PROMPT = "x".repeat(2500);

describe("CodeBuddyExecutor keeps the caller's system prompt by default", () => {
  const exec = new CodeBuddyExecutor();
  const run = (messages, credentials = {}) =>
    exec.transformRequest("glm-5.2", { messages }, false, credentials);
  const systemText = (out) => {
    const sys = out.messages.find((m) => m.role === "system");
    return Array.isArray(sys.content) ? sys.content.map((b) => b.text).join("") : sys.content;
  };

  it("does NOT rewrite an agent-looking system prompt", () => {
    const out = run([{ role: "system", content: AGENT_PROMPT }, { role: "user", content: "hi" }]);
    expect(systemText(out)).toBe(AGENT_PROMPT);
  });

  it("does NOT rewrite a long (>2000 char) system prompt", () => {
    const out = run([{ role: "system", content: LONG_PROMPT }, { role: "user", content: "hi" }]);
    expect(systemText(out)).toBe(LONG_PROMPT);
  });

  it("leaves an ordinary short system prompt untouched", () => {
    const out = run([{ role: "system", content: "Be concise." }, { role: "user", content: "hi" }]);
    expect(systemText(out)).toBe("Be concise.");
  });

  it("still forces stream:true (gateway rejects non-stream)", () => {
    const out = run([{ role: "user", content: "hi" }]);
    expect(out.stream).toBe(true);
  });

  it("preserves developer messages rather than dropping them", () => {
    const out = run([{ role: "developer", content: "Be terse." }, { role: "user", content: "hi" }]);
    expect(out.messages.some((m) => m.role === "developer" && m.content === "Be terse.")).toBe(true);
  });
});

describe("CodeBuddyExecutor neutralization is opt-in", () => {
  const exec = new CodeBuddyExecutor();
  const run = (messages, credentials) =>
    exec.transformRequest("glm-5.2", { messages }, false, credentials);
  const opts = { providerSpecificData: { neutralizeAgentPrompt: true } };

  it("rewrites an agent system prompt when explicitly enabled", () => {
    const out = run([{ role: "system", content: AGENT_PROMPT }, { role: "user", content: "hi" }], opts);
    expect(out.messages.find((m) => m.role === "system").content).toBe(NEUTRAL);
  });

  it("rewrites a long system prompt when explicitly enabled", () => {
    const out = run([{ role: "system", content: LONG_PROMPT }, { role: "user", content: "hi" }], opts);
    expect(out.messages.find((m) => m.role === "system").content).toBe(NEUTRAL);
  });

  it("leaves legitimate short user prompts untouched even when enabled", () => {
    const out = run([{ role: "system", content: "Be concise." }, { role: "user", content: "hi" }], opts);
    expect(out.messages.find((m) => m.role === "system").content).toBe("Be concise.");
  });

  it("preserves typed-block shape when rewriting", () => {
    const out = run(
      [{ role: "system", content: [{ type: "text", text: AGENT_PROMPT }] }, { role: "user", content: "hi" }],
      opts
    );
    expect(out.messages.find((m) => m.role === "system").content).toEqual([{ type: "text", text: NEUTRAL }]);
  });

  it("is inert when the flag is absent or false", () => {
    for (const creds of [{}, { providerSpecificData: {} }, { providerSpecificData: { neutralizeAgentPrompt: false } }]) {
      const out = run([{ role: "system", content: AGENT_PROMPT }, { role: "user", content: "hi" }], creds);
      expect(out.messages.find((m) => m.role === "system").content).toBe(AGENT_PROMPT);
    }
  });
});
