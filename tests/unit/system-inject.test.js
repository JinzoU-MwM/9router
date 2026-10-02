import { describe, it, expect } from "vitest";
import { injectSystemPrompt, injectUserPrefix, injectFewShot, hasToolDeclarations, isFreshSession } from "../../open-sse/rtk/systemInject.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { OPENAI_BLOCK, CLAUDE_BLOCK, RESPONSES_ITEM } from "../../open-sse/translator/schema/blocks.js";
import { ROLE } from "../../open-sse/translator/schema/roles.js";
import { injectCaveman } from "../../open-sse/rtk/caveman.js";
import { injectPonytail } from "../../open-sse/rtk/ponytail.js";
import { CAVEMAN_PROMPTS } from "../../open-sse/rtk/cavemanPrompts.js";
import { PONYTAIL_PROMPTS } from "../../open-sse/rtk/ponytailPrompt.js";

const SEP = "\n\n";
const P1 = "CAVEMAN_TEST_PROMPT_AAA";
const P2 = "PONYTAIL_TEST_PROMPT_BBB";

// Contract note: injectSystemPrompt inserts the prompt as its OWN system message
// (spliced after the last existing system/developer message) rather than appending
// it into the caller's system message. Appending into one message can push it past
// upstream per-message size limits (~2-3KB on some providers) and silently delete
// the persona. The caller's original system message is never mutated.
describe("system-inject chat messages", () => {
  it("inserts a separate system message after an existing system string", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "hello" }, { role: ROLE.USER, content: "hi" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    expect(body.messages[0]).toEqual({ role: ROLE.SYSTEM, content: "hello" });
    expect(body.messages[1]).toEqual({ role: ROLE.SYSTEM, content: P1 });
    expect(body.messages[2].role).toBe(ROLE.USER);
  });

  it("inserts a separate system message after an existing system array (never input_text)", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: [{ type: OPENAI_BLOCK.TEXT, text: "hello" }] }] };
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    // original array untouched, separate message carries the prompt as a plain string
    expect(body.messages[0].content).toEqual([{ type: OPENAI_BLOCK.TEXT, text: "hello" }]);
    expect(body.messages[1]).toEqual({ role: ROLE.SYSTEM, content: P1 });
    expect(body.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === "input_text"))).toBe(false);
  });

  it("unshifts system message when no system/developer present", () => {
    const body = { messages: [{ role: ROLE.USER, content: "hi" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    expect(body.messages[0]).toEqual({ role: ROLE.SYSTEM, content: P1 });
    expect(body.messages[1].role).toBe(ROLE.USER);
  });

  it("handles developer role as system", () => {
    const body = { messages: [{ role: ROLE.DEVELOPER, content: "dev" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    expect(body.messages[0]).toEqual({ role: ROLE.DEVELOPER, content: "dev" });
    expect(body.messages[1]).toEqual({ role: ROLE.SYSTEM, content: P1 });
  });

  it("exact full-prompt idempotency for chat string", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "hello" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    expect(body.messages.filter(m => m.content === P1).length).toBe(1);
    // different prompt both apply
    injectSystemPrompt(body, FORMATS.OPENAI, P2);
    expect(body.messages.some(m => m.content === P1)).toBe(true);
    expect(body.messages.some(m => m.content === P2)).toBe(true);
  });

  it("exact full-prompt idempotency for chat array", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: [{ type: OPENAI_BLOCK.TEXT, text: "hello" }] }] };
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    expect(body.messages.filter(m => m.content === P1).length).toBe(1);
    injectSystemPrompt(body, FORMATS.OPENAI, P2);
    expect(body.messages.filter(m => m.content === P2).length).toBe(1);
  });

  it("never uses first-100 fingerprint: long prompt exact idempotency", () => {
    const longA = "X".repeat(150) + "_A";
    const longB = "X".repeat(150) + "_B";
    const body = { messages: [{ role: ROLE.SYSTEM, content: "base" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, longA);
    injectSystemPrompt(body, FORMATS.OPENAI, longB);
    expect(body.messages.some(m => m.content === longA)).toBe(true);
    expect(body.messages.some(m => m.content === longB)).toBe(true);
    // retry same longA is idempotent
    injectSystemPrompt(body, FORMATS.OPENAI, longA);
    const countA = body.messages.filter(m => m.content === longA).length;
    expect(countA).toBe(1);
  });
});

describe("system-inject responses input[]", () => {
  it("inserts a separate system message item and preserves non-message order", () => {
    const body = {
      input: [
        { type: RESPONSES_ITEM.FUNCTION_CALL, call_id: "c1", name: "fn" },
        { type: RESPONSES_ITEM.MESSAGE, role: ROLE.SYSTEM, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "sys" }] },
        { type: RESPONSES_ITEM.REASONING, summary: "x" },
        { type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT, call_id: "c1", output: "ok" },
      ],
    };
    const before = JSON.parse(JSON.stringify(body.input));
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    // one extra item inserted right after the existing system message
    expect(body.input.length).toBe(before.length + 1);
    expect(body.input[0]).toEqual(before[0]);
    expect(body.input[1]).toEqual(before[1]); // original system message untouched
    expect(body.input[2]).toEqual({ type: RESPONSES_ITEM.MESSAGE, role: ROLE.SYSTEM, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: P1 }] });
    // non-message items keep their relative order after the inserted message
    expect(body.input[3]).toEqual(before[2]);
    expect(body.input[4]).toEqual(before[3]);
  });

  it("inserts a separate typed system message item", () => {
    const body = { input: [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "hi" }] }, { type: RESPONSES_ITEM.MESSAGE, role: ROLE.SYSTEM, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "base" }] }] };
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    const injected = body.input[body.input.length - 1];
    expect(injected.type).toBe(RESPONSES_ITEM.MESSAGE);
    expect(injected.role).toBe(ROLE.SYSTEM);
    expect(injected.content[0].type).toBe(RESPONSES_ITEM.INPUT_TEXT);
    expect(injected.content[0].text).toBe(P1);
  });

  it("creates typed message at index 0 if absent preserving order", () => {
    const body = { input: [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "hi" }] }, { type: RESPONSES_ITEM.FUNCTION_CALL, call_id: "1", name: "a" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    expect(body.input[0]).toEqual({ type: RESPONSES_ITEM.MESSAGE, role: ROLE.SYSTEM, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: P1 }] });
    expect(body.input[1].role).toBe(ROLE.USER);
  });

  it("instructions string takes precedence over input[]", () => {
    const body = { instructions: "instr", input: [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "hi" }] }] };
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    expect(body.instructions).toBe(`instr${SEP}${P1}`);
    expect(body.input.length).toBe(1);
    expect(body.input[0].content[0].text).toBe("hi");
  });

  it("does not coerce string input", () => {
    const body = { input: "hello string" };
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    expect(body.input).toBe("hello string");
    expect(body.instructions).toBeUndefined();
  });

  it("exact idempotency for responses input", () => {
    const body = { input: [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.SYSTEM, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "base" }] }] };
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    const countP1 = body.input.filter(m => Array.isArray(m.content) && m.content.some(c => c.text === P1)).length;
    expect(countP1).toBe(1);
    injectSystemPrompt(body, FORMATS.OPENAI, P2);
    const countP2 = body.input.filter(m => Array.isArray(m.content) && m.content.some(c => c.text === P2)).length;
    expect(countP2).toBe(1);
  });
});

describe("system-inject instructions", () => {
  it("appends to instructions string with idempotency", () => {
    const body = { instructions: "base" };
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    expect(body.instructions).toBe(`base${SEP}${P1}`);
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    expect(body.instructions).toBe(`base${SEP}${P1}`);
    injectSystemPrompt(body, FORMATS.OPENAI, P2);
    expect(body.instructions).toBe(`base${SEP}${P1}${SEP}${P2}`);
  });

  it("creates instructions when empty", () => {
    const body = { instructions: "" };
    // empty string still taken as string field, should become prompt
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    expect(body.instructions).toBe(P1);
  });
});

describe("system-inject dispatch by wire shape", () => {
  it("messages[] means Chat even when format is openai-responses label", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "hi" }] };
    injectSystemPrompt(body, FORMATS.OPENAI_RESPONSES, P1);
    // should still treat as Chat because messages present — separate system message
    expect(body.messages[0]).toEqual({ role: ROLE.SYSTEM, content: "hi" });
    expect(body.messages[1]).toEqual({ role: ROLE.SYSTEM, content: P1 });
    expect(body.input).toBeUndefined();
  });
  it("input[] means Responses even when format is openai", () => {
    const body = { input: [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "hi" }] }] };
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    expect(body.input[0].role).toBe(ROLE.SYSTEM);
    expect(body.input[0].content[0].type).toBe(RESPONSES_ITEM.INPUT_TEXT);
  });
});

describe("system-inject claude", () => {
  it("string system appends with SEP and idempotent", () => {
    const body = { system: "base" };
    injectSystemPrompt(body, FORMATS.CLAUDE, P1);
    expect(body.system).toBe(`base${SEP}${P1}`);
    injectSystemPrompt(body, FORMATS.CLAUDE, P1);
    expect(body.system).toBe(`base${SEP}${P1}`);
    injectSystemPrompt(body, FORMATS.CLAUDE, P2);
    expect(body.system).toBe(`base${SEP}${P1}${SEP}${P2}`);
  });

  it("array system uses CLAUDE_BLOCK.TEXT and inserts before last cache_control", () => {
    const body = { system: [{ type: CLAUDE_BLOCK.TEXT, text: "a" }, { type: CLAUDE_BLOCK.TEXT, text: "b", cache_control: { type: "ephemeral" } }, { type: CLAUDE_BLOCK.TEXT, text: "c", cache_control: { type: "ephemeral" } }] };
    injectSystemPrompt(body, FORMATS.CLAUDE, P1);
    // should be inserted before last cache_control (index 2)
    expect(body.system[2]).toEqual({ type: CLAUDE_BLOCK.TEXT, text: P1 });
    expect(body.system[3].text).toBe("c");
    expect(body.system[3].cache_control).toBeDefined();
  });

  it("array without cache_control appends", () => {
    const body = { system: [{ type: CLAUDE_BLOCK.TEXT, text: "a" }] };
    injectSystemPrompt(body, FORMATS.CLAUDE, P1);
    expect(body.system[body.system.length - 1]).toEqual({ type: CLAUDE_BLOCK.TEXT, text: P1 });
  });

  it("exact idempotency for claude array", () => {
    const body = { system: [{ type: CLAUDE_BLOCK.TEXT, text: "a" }] };
    injectSystemPrompt(body, FORMATS.CLAUDE, P1);
    injectSystemPrompt(body, FORMATS.CLAUDE, P1);
    expect(body.system.filter(b => b.text === P1).length).toBe(1);
  });

  it("creates system when absent", () => {
    const body = {};
    injectSystemPrompt(body, FORMATS.CLAUDE, P1);
    expect(body.system).toBe(P1);
  });

  it("real body with messages[] injects into system, never a system role turn", () => {
    const body = { system: "base", messages: [{ role: ROLE.USER, content: "hi" }] };
    injectSystemPrompt(body, FORMATS.CLAUDE, P1);
    expect(body.system).toBe(`base${SEP}${P1}`);
    expect(body.messages).toEqual([{ role: ROLE.USER, content: "hi" }]);
  });

  it("absent system with messages[] creates system field, not a system message", () => {
    const body = { messages: [{ role: ROLE.USER, content: "hi" }] };
    injectSystemPrompt(body, FORMATS.CLAUDE, P1);
    expect(body.system).toBe(P1);
    expect(body.messages.some(m => m.role === ROLE.SYSTEM)).toBe(false);
  });
});

describe("system-inject gemini", () => {
  it("preserves snake_case key", () => {
    const body = { system_instruction: { parts: [{ text: "base" }] } };
    injectSystemPrompt(body, FORMATS.GEMINI, P1);
    expect(body.system_instruction.parts.length).toBe(2);
    expect(body.system_instruction.parts[1].text).toBe(P1);
    expect(body.systemInstruction).toBeUndefined();
  });
  it("preserves camelCase key", () => {
    const body = { systemInstruction: { parts: [{ text: "base" }] } };
    injectSystemPrompt(body, FORMATS.GEMINI, P1);
    expect(body.systemInstruction.parts[1].text).toBe(P1);
    expect(body.system_instruction).toBeUndefined();
  });
  it("handles Antigravity wrapper request.systemInstruction", () => {
    const body = { request: { systemInstruction: { parts: [{ text: "base" }] } } };
    injectSystemPrompt(body, FORMATS.ANTIGRAVITY, P1);
    expect(body.request.systemInstruction.parts[1].text).toBe(P1);
  });
  it("exact idempotency for gemini", () => {
    const body = { systemInstruction: { parts: [{ text: "base" }] } };
    injectSystemPrompt(body, FORMATS.GEMINI, P1);
    injectSystemPrompt(body, FORMATS.GEMINI, P1);
    expect(body.systemInstruction.parts.filter(p => p.text === P1).length).toBe(1);
    injectSystemPrompt(body, FORMATS.GEMINI, P2);
    expect(body.systemInstruction.parts.filter(p => p.text === P2).length).toBe(1);
  });
  it("creates when absent", () => {
    const body = {};
    injectSystemPrompt(body, FORMATS.GEMINI, P1);
    expect(body.systemInstruction.parts[0].text).toBe(P1);
  });
});

describe("system-inject kiro", () => {
  // The kiro.dev gateway rejects any body carrying a top-level `systemPrompt`
  // with 400 REQUEST_BODY_INVALID, so the prompt goes into the user turn only.
  it("appends to first history user, leaves systemPrompt untouched", () => {
    const timeCtx = "[Context: Current time is 2026-01-01T00:00:00.000Z]";
    const tail = "user tail content";
    const historyUserContent = `${timeCtx}${SEP}${tail}`;
    const body = {
      conversationState: {
        history: [{ userInputMessage: { content: historyUserContent, modelId: "m" } }, { assistantResponseMessage: { content: "..." } }],
        currentMessage: { userInputMessage: { content: "current " + tail, modelId: "m" } },
      },
    };
    injectSystemPrompt(body, FORMATS.KIRO, P1);
    expect(body.systemPrompt).toBeUndefined();
    expect(body.conversationState.history[0].userInputMessage.content).toBe(`${historyUserContent}${SEP}${P1}`);
    // currentMessage must stay untouched
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe("current " + tail);
  });

  it("never writes a top-level systemPrompt, even if one is already present", () => {
    const body = {
      systemPrompt: "OLD",
      conversationState: {
        history: [{ userInputMessage: { content: "tail", modelId: "m" } }],
      },
    };
    injectSystemPrompt(body, FORMATS.KIRO, P1);
    expect(body.systemPrompt).toBe("OLD");
    expect(body.conversationState.history[0].userInputMessage.content).toBe(`tail${SEP}${P1}`);
  });

  it("when no history user, updates currentMessage instead", () => {
    const body = {
      conversationState: {
        history: [],
        currentMessage: { userInputMessage: { content: "tail", modelId: "m" } },
      },
    };
    injectSystemPrompt(body, FORMATS.KIRO, P1);
    expect(body.systemPrompt).toBeUndefined();
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe(`tail${SEP}${P1}`);
  });

  it("empty user content becomes the prompt itself", () => {
    const body = {
      conversationState: {
        history: [{ userInputMessage: { content: "", modelId: "m" } }],
        currentMessage: { userInputMessage: { content: "cur", modelId: "m" } },
      },
    };
    injectSystemPrompt(body, FORMATS.KIRO, P1);
    expect(body.conversationState.history[0].userInputMessage.content).toBe(P1);
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe("cur");
  });

  it("exact retry idempotency for kiro", () => {
    const body = {
      conversationState: {
        history: [{ userInputMessage: { content: "tail", modelId: "m" } }],
        currentMessage: { userInputMessage: { content: "cur", modelId: "m" } },
      },
    };
    injectSystemPrompt(body, FORMATS.KIRO, P1);
    const after1 = body.conversationState.history[0].userInputMessage.content;
    injectSystemPrompt(body, FORMATS.KIRO, P1);
    expect(body.conversationState.history[0].userInputMessage.content).toBe(after1);
    // different prompt both apply, in injection order
    injectSystemPrompt(body, FORMATS.KIRO, P2);
    expect(body.conversationState.history[0].userInputMessage.content).toBe(`tail${SEP}${P1}${SEP}${P2}`);
  });

  it("preserves non-enumerable _kiroUpstreamModel", () => {
    const body = {
      conversationState: { history: [{ userInputMessage: { content: "tail", modelId: "m" } }], currentMessage: { userInputMessage: { content: "tail2", modelId: "m" } } },
    };
    Object.defineProperty(body, "_kiroUpstreamModel", { value: "m", enumerable: false });
    injectSystemPrompt(body, FORMATS.KIRO, P1);
    expect(body._kiroUpstreamModel).toBe("m");
    expect(Object.getOwnPropertyDescriptor(body, "_kiroUpstreamModel").enumerable).toBe(false);
  });

  it("frozen user message fails open without throwing or half-writing", () => {
    const body = {
      conversationState: {
        history: [{ userInputMessage: Object.freeze({ content: "tail", modelId: "m" }) }],
      },
    };
    expect(() => injectSystemPrompt(body, FORMATS.KIRO, P1)).not.toThrow();
    expect(body.systemPrompt).toBeUndefined();
    expect(body.conversationState.history[0].userInputMessage.content).toBe("tail");
  });
});

describe("system-inject regression fixes", () => {
  it("kiro partial mutation converges on retry after transient content write failure", () => {
    let failNextWrite = true;
    const um = { content: "tail", modelId: "m" };
    const proxiedUm = new Proxy(um, {
      set(t, p, v) {
        if (p === "content" && failNextWrite) { failNextWrite = false; throw new Error("transient"); }
        t[p] = v; return true;
      },
    });
    const body = { conversationState: { history: [{ userInputMessage: proxiedUm }] } };
    injectSystemPrompt(body, FORMATS.KIRO, P1);
    // nothing half-applied
    expect(um.content).toBe("tail");
    expect(body.systemPrompt).toBeUndefined();
    // retry converges
    injectSystemPrompt(body, FORMATS.KIRO, P1);
    expect(um.content).toBe(`tail${SEP}${P1}`);
  });

  it("kiro shape gate: stray conversationState without history/currentMessage does not hijack chat body", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "hello" }], conversationState: {} };
    injectSystemPrompt(body, FORMATS.OPENAI, P1);
    // treated as Chat, not Kiro — separate system message inserted
    expect(body.messages[0]).toEqual({ role: ROLE.SYSTEM, content: "hello" });
    expect(body.messages[1]).toEqual({ role: ROLE.SYSTEM, content: P1 });
  });

  it("substring occurrence does not suppress injection (exact SEP-delimited idempotency)", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "You are RULE follower" }] };
    injectSystemPrompt(body, FORMATS.OPENAI, "RULE");
    // separate system message, caller's message untouched — substring never suppresses
    expect(body.messages[1]).toEqual({ role: ROLE.SYSTEM, content: "RULE" });
  });

  it("instructions substring occurrence does not suppress injection", () => {
    const body = { instructions: "You are RULE follower" };
    injectSystemPrompt(body, FORMATS.OPENAI, "RULE");
    expect(body.instructions).toBe(`You are RULE follower${SEP}RULE`);
  });

  it("substring occurrence does not suppress kiro injection", () => {
    const body = {
      conversationState: {
        history: [{ userInputMessage: { content: `some ${P1} here`, modelId: "m" } }],
      },
    };
    injectSystemPrompt(body, FORMATS.KIRO, P1);
    expect(body.conversationState.history[0].userInputMessage.content).toBe(`some ${P1} here${SEP}${P1}`);
  });
});

describe("system-inject fail-open", () => {
  it("null/undefined bodies never throw", () => {
    expect(() => injectSystemPrompt(null, FORMATS.OPENAI, P1)).not.toThrow();
    expect(() => injectSystemPrompt(undefined, FORMATS.OPENAI, P1)).not.toThrow();
    expect(() => injectSystemPrompt({}, FORMATS.OPENAI, null)).not.toThrow();
  });

  it("malformed messages array never throws", () => {
    expect(() => injectSystemPrompt({ messages: null }, FORMATS.OPENAI, P1)).not.toThrow();
    expect(() => injectSystemPrompt({ messages: "bad" }, FORMATS.OPENAI, P1)).not.toThrow();
    expect(() => injectSystemPrompt({ messages: [{ role: null, content: null }] }, FORMATS.OPENAI, P1)).not.toThrow();
  });

  it("frozen body never throws and does not partially mutate", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "hello" }] };
    Object.freeze(body);
    Object.freeze(body.messages);
    Object.freeze(body.messages[0]);
    expect(() => injectSystemPrompt(body, FORMATS.OPENAI, P1)).not.toThrow();
    expect(body.messages[0].content).toBe("hello");
  });

  it("Proxy throwing setter never throws", () => {
    const throwingMsg = new Proxy({ role: ROLE.SYSTEM, content: "hello" }, {
      set() { throw new Error("msg setter fail"); },
    });
    const arrProxy = new Proxy([throwingMsg], {
      get(t, p, r) { return Reflect.get(t, p, r); },
      set() { throw new Error("arr setter fail"); },
    });
    const proxy = new Proxy({}, {
      set(t, p, v) { if (p === "messages") throw new Error("setter fail"); return Reflect.set(t, p, v); },
      get(t, p) { if (p === "messages") return arrProxy; return t[p]; },
    });
    expect(() => injectSystemPrompt(proxy, FORMATS.OPENAI, P1)).not.toThrow();
    expect(() => injectSystemPrompt(proxy, FORMATS.OPENAI_RESPONSES, P1)).not.toThrow();
  });

  it("frozen claude never throws", () => {
    const body = { system: [{ type: CLAUDE_BLOCK.TEXT, text: "a" }] };
    Object.freeze(body.system);
    expect(() => injectSystemPrompt(body, FORMATS.CLAUDE, P1)).not.toThrow();
  });

  it("frozen gemini never throws", () => {
    const body = { systemInstruction: { parts: [{ text: "a" }] } };
    Object.freeze(body.systemInstruction.parts);
    expect(() => injectSystemPrompt(body, FORMATS.GEMINI, P1)).not.toThrow();
  });

  it("injectCaveman and injectPonytail fail open on frozen", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "hi" }] };
    Object.freeze(body);
    Object.freeze(body.messages);
    expect(() => injectCaveman(body, FORMATS.OPENAI, "full")).not.toThrow();
    expect(() => injectPonytail(body, FORMATS.OPENAI, "full")).not.toThrow();
  });

  it("different caveman and ponytail prompts both apply", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "base" }] };
    injectCaveman(body, FORMATS.OPENAI, "full");
    // each prompt lands as its own system message; caller's message untouched
    expect(body.messages[0]).toEqual({ role: ROLE.SYSTEM, content: "base" });
    const texts = body.messages.filter(m => typeof m.content === "string").map(m => m.content);
    expect(texts.some(t => t.includes(CAVEMAN_PROMPTS.full.slice(0, 30)))).toBe(true);
    injectPonytail(body, FORMATS.OPENAI, "full");
    const texts2 = body.messages.filter(m => typeof m.content === "string").map(m => m.content);
    expect(texts2.some(t => t.includes(PONYTAIL_PROMPTS.full.slice(0, 30)))).toBe(true);
    expect(texts2.some(t => t.includes(CAVEMAN_PROMPTS.full.slice(0, 30)))).toBe(true);
    expect(body.messages[0]).toEqual({ role: ROLE.SYSTEM, content: "base" });
  });
});

// Gemini / Antigravity keep turns in contents[] (roles user/model — there is no
// system role) and Antigravity wraps them under `request`; Kiro keeps them under
// conversationState. injectUserPrefix used to scan only messages[]/input[], so
// the anti-greeting marker silently never landed on any of those providers.
describe("injectUserPrefix — gemini / antigravity / kiro shapes", () => {
  const MARK = "[TASK-DIRECT]";

  it("prefixes the last user part of a Gemini contents[] body", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    injectUserPrefix(body, FORMATS.GEMINI, MARK);
    expect(body.contents[0].parts[0].text).toBe(`${MARK} hi`);
  });

  it("prefixes only the LAST user content", () => {
    const body = { contents: [
      { role: "user", parts: [{ text: "first" }] },
      { role: "model", parts: [{ text: "ok" }] },
      { role: "user", parts: [{ text: "second" }] },
    ] };
    injectUserPrefix(body, FORMATS.GEMINI, MARK);
    expect(body.contents[0].parts[0].text).toBe("first");
    expect(body.contents[2].parts[0].text).toBe(`${MARK} second`);
  });

  it("skips a leading non-text part and uses the first text part", () => {
    const body = { contents: [{ role: "user", parts: [{ functionCall: { name: "f" } }, { text: "hi" }] }] };
    injectUserPrefix(body, FORMATS.GEMINI, MARK);
    expect(body.contents[0].parts[0].functionCall).toEqual({ name: "f" });
    expect(body.contents[0].parts[1].text).toBe(`${MARK} hi`);
  });

  it("reaches Antigravity's request-wrapped contents", () => {
    const body = { project: "p", request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } };
    injectUserPrefix(body, FORMATS.ANTIGRAVITY, MARK);
    expect(body.request.contents[0].parts[0].text).toBe(`${MARK} hi`);
  });

  it("prefixes the Kiro live turn", () => {
    const body = { conversationState: { currentMessage: { userInputMessage: { content: "hi" } } } };
    injectUserPrefix(body, FORMATS.KIRO, MARK);
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe(`${MARK} hi`);
  });

  it("falls back to the last Kiro history turn when there is no live turn", () => {
    const body = { conversationState: { history: [
      { userInputMessage: { content: "old" } },
      { assistantResponseMessage: { content: "ok" } },
    ] } };
    injectUserPrefix(body, FORMATS.KIRO, MARK);
    expect(body.conversationState.history[0].userInputMessage.content).toBe(`${MARK} old`);
  });

  it("is idempotent on every new shape", () => {
    const cases = [
      [{ contents: [{ role: "user", parts: [{ text: "hi" }] }] }, FORMATS.GEMINI],
      [{ request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } }, FORMATS.ANTIGRAVITY],
      [{ conversationState: { currentMessage: { userInputMessage: { content: "hi" } } } }, FORMATS.KIRO],
    ];
    for (const [b, f] of cases) {
      injectUserPrefix(b, f, MARK);
      injectUserPrefix(b, f, MARK);
      expect(JSON.stringify(b).split(MARK).length - 1).toBe(1);
    }
  });

  it("leaves a body with no user turn untouched", () => {
    const body = { contents: [{ role: "model", parts: [{ text: "prev" }] }] };
    injectUserPrefix(body, FORMATS.GEMINI, MARK);
    expect(body.contents[0].parts[0].text).toBe("prev");
  });

  it("fail-open on a frozen Gemini body", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    Object.freeze(body.contents[0].parts[0]);
    expect(() => injectUserPrefix(body, FORMATS.GEMINI, MARK)).not.toThrow();
  });
});

// Few-shot priming. Restating a rule costs instruction weight, and instruction
// weight is what trips a filter; showing the same behaviour inside real
// assistant turns does not. The turns go immediately BEFORE the live user turn
// so the worked example is the last thing read before the model has to answer.
describe("injectFewShot — few-shot priming", () => {
  const TURNS = [
    { role: "user", content: "ASK-1" },
    { role: "assistant", content: "MARK 1" },
    { role: "user", content: "ASK-2" },
    { role: "assistant", content: "MARK 2" },
  ];

  it("splices the pairs before the live user turn (chat)", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "sys" }, { role: ROLE.USER, content: "live" }] };
    expect(injectFewShot(body, FORMATS.OPENAI, TURNS)).toBe(true);
    expect(body.messages.map((m) => m.role)).toEqual([
      ROLE.SYSTEM, ROLE.USER, ROLE.ASSISTANT, ROLE.USER, ROLE.ASSISTANT, ROLE.USER,
    ]);
    expect(body.messages[1].content).toBe("ASK-1");
    expect(body.messages[body.messages.length - 1].content).toBe("live");
  });

  it("uses typed items for a Responses input[] body", () => {
    const body = { input: [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "live" }] }] };
    expect(injectFewShot(body, FORMATS.OPENAI_RESPONSES, TURNS)).toBe(true);
    expect(body.input).toHaveLength(5);
    expect(body.input[0].role).toBe(ROLE.USER);
    expect(body.input[1].role).toBe(ROLE.ASSISTANT);
    expect(body.input[1].content[0].type).toBe(RESPONSES_ITEM.OUTPUT_TEXT);
    expect(body.input[body.input.length - 1].content[0].text).toBe("live");
  });

  it("alternates user|model for a fresh Gemini body", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "live" }] }] };
    expect(injectFewShot(body, FORMATS.GEMINI, TURNS)).toBe(true);
    expect(body.contents.map((c) => c.role)).toEqual([
      "user", "model", "user", "model", "user",
    ]);
  });

  it("stays out of a session that already has an assistant turn", () => {
    // The greeting race is a first-turn phenomenon; by turn two the pattern is
    // already in context and priming only buys ~150 tokens of nothing.
    for (const body of [
      { messages: [{ role: ROLE.USER, content: "a" }, { role: ROLE.ASSISTANT, content: "b" }, { role: ROLE.USER, content: "live" }] },
      { input: [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.ASSISTANT, content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text: "b" }] }, { type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "live" }] }] },
      { contents: [{ role: "model", parts: [{ text: "b" }] }, { role: "user", parts: [{ text: "live" }] }] },
      { conversationState: { history: [{ assistantResponseMessage: { content: "b" } }], currentMessage: { userInputMessage: { content: "live" } } } },
    ]) {
      expect(injectFewShot(body, FORMATS.OPENAI, TURNS)).toBe(false);
    }
    expect(isFreshSession({ messages: [{ role: ROLE.USER, content: "live" }] })).toBe(true);
    expect(isFreshSession({ contents: [{ role: "user", parts: [{ text: "live" }] }] })).toBe(true);
    expect(isFreshSession(null)).toBe(false);
  });

  it("refuses to prime Gemini when the turn before the live one is also a user", () => {
    const body = { contents: [
      { role: "user", parts: [{ text: "a" }] },
      { role: "user", parts: [{ text: "live" }] },
    ] };
    expect(injectFewShot(body, FORMATS.GEMINI, TURNS)).toBe(false);
    expect(body.contents).toHaveLength(2);
  });

  it("stays out of a request that declares tools", () => {
    const body = { messages: [{ role: ROLE.USER, content: "live" }], tools: [{ type: "function", function: { name: "f" } }] };
    expect(hasToolDeclarations(body)).toBe(true);
    expect(injectFewShot(body, FORMATS.OPENAI, TURNS)).toBe(false);
    expect(body.messages).toHaveLength(1);
  });

  it("detects tools on the Gemini and Kiro shapes too", () => {
    expect(hasToolDeclarations({ request: { contents: [], tools: [{ name: "f" }] } })).toBe(true);
    expect(hasToolDeclarations({ conversationState: { currentMessage: { userInputMessage: { userInputMessageContext: { tools: [{ name: "f" }] } } } } })).toBe(true);
    expect(hasToolDeclarations({ messages: [] })).toBe(false);
  });

  it("is idempotent — a primed body is left untouched", () => {
    const body = { messages: [{ role: ROLE.USER, content: "live" }] };
    injectFewShot(body, FORMATS.OPENAI, TURNS);
    const once = body.messages.length;
    expect(injectFewShot(body, FORMATS.OPENAI, TURNS)).toBe(false);
    expect(body.messages.length).toBe(once);
  });

  it("no-ops without a live user turn, on an incomplete pair, or on junk", () => {
    expect(injectFewShot({ messages: [{ role: ROLE.SYSTEM, content: "s" }] }, FORMATS.OPENAI, TURNS)).toBe(false);
    expect(injectFewShot({ messages: [{ role: ROLE.USER, content: "live" }] }, FORMATS.OPENAI, [{ role: "user", content: "only" }])).toBe(false);
    expect(injectFewShot({ messages: [] }, FORMATS.OPENAI, null)).toBe(false);
  });

  it("fail-open on a frozen body", () => {
    const body = { messages: [{ role: ROLE.USER, content: "live" }] };
    Object.freeze(body.messages);
    expect(() => injectFewShot(body, FORMATS.OPENAI, TURNS)).not.toThrow();
  });

  it("does not prime a Kiro body (translator owns that item shape)", () => {
    const body = { conversationState: { currentMessage: { userInputMessage: { content: "live" } } } };
    expect(injectFewShot(body, FORMATS.KIRO, TURNS)).toBe(false);
  });
});
