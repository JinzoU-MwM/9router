import { describe, it, expect } from "vitest";
import { detectClientPersona, reinforcePersona, precedenceAnchor } from "../../open-sse/rtk/personaAmplify.js";
import { ROLE } from "../../open-sse/translator/schema/roles.js";
import { RESPONSES_ITEM, CLAUDE_BLOCK } from "../../open-sse/translator/schema/blocks.js";

describe("detectClientPersona", () => {
  it("returns 0 for a body with no system message", () => {
    expect(detectClientPersona({ messages: [{ role: ROLE.USER, content: "hi" }] }, "openai")).toBe(0);
  });

  it("sums system message length (chat)", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "abcde" }, { role: ROLE.USER, content: "hi" }] };
    expect(detectClientPersona(body, "openai")).toBe(5);
  });

  it("reads Claude native system string", () => {
    expect(detectClientPersona({ system: "1234" }, "claude")).toBe(4);
  });

  it("reads Responses input[] system item", () => {
    const body = { input: [{ type: RESPONSES_ITEM.MESSAGE, role: ROLE.SYSTEM, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "abcdefg" }] }] };
    expect(detectClientPersona(body, "openai")).toBe(7);
  });

  it("fail-open on null body", () => {
    expect(detectClientPersona(null, "openai")).toBe(0);
  });
});

describe("reinforcePersona", () => {
  it("inserts the anchor immediately before the last user turn (chat)", () => {
    const body = { messages: [
      { role: ROLE.SYSTEM, content: "persona" },
      { role: ROLE.ASSISTANT, content: "ok" },
      { role: ROLE.USER, content: "task" },
    ] };
    const changed = reinforcePersona(body, "openai", "ANCHOR");
    expect(changed).toBe(true);
    // anchor sits right before the user turn
    expect(body.messages[body.messages.length - 2]).toEqual({ role: ROLE.SYSTEM, content: "ANCHOR" });
    expect(body.messages[body.messages.length - 1].role).toBe(ROLE.USER);
  });

  it("is idempotent — a body already carrying the anchor is unchanged", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "ANCHOR" }, { role: ROLE.USER, content: "t" }] };
    expect(reinforcePersona(body, "openai", "ANCHOR")).toBe(false);
    expect(body.messages.filter(m => m.content === "ANCHOR").length).toBe(1);
  });

  it("appends a separate anchor block for Claude array system", () => {
    const body = { system: [{ type: CLAUDE_BLOCK.TEXT, text: "persona" }], messages: [{ role: ROLE.USER, content: "t" }] };
    expect(reinforcePersona(body, "claude", "ANCHOR")).toBe(true);
    expect(body.system[body.system.length - 1]).toEqual({ type: CLAUDE_BLOCK.TEXT, text: "ANCHOR" });
  });

  it("appends to Claude native system string", () => {
    const body = { system: "persona" };
    expect(reinforcePersona(body, "claude", "ANCHOR")).toBe(true);
    expect(body.system).toContain("ANCHOR");
  });

  it("inserts a Responses-typed anchor before the last user item", () => {
    const body = { input: [
      { type: RESPONSES_ITEM.MESSAGE, role: ROLE.SYSTEM, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "persona" }] },
      { type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: "task" }] },
    ] };
    expect(reinforcePersona(body, "openai", "ANCHOR")).toBe(true);
    const anchor = body.input[body.input.length - 2];
    expect(anchor.role).toBe(ROLE.SYSTEM);
    expect(anchor.content[0].text).toBe("ANCHOR");
    expect(body.input[body.input.length - 1].role).toBe(ROLE.USER);
  });

  it("pushes the anchor when there is no user turn", () => {
    const body = { messages: [{ role: ROLE.SYSTEM, content: "p" }] };
    expect(reinforcePersona(body, "openai", "ANCHOR")).toBe(true);
    expect(body.messages[body.messages.length - 1].content).toBe("ANCHOR");
  });

  it("fail-open on frozen body", () => {
    const body = { messages: [{ role: ROLE.USER, content: "t" }] };
    Object.freeze(body.messages);
    expect(() => reinforcePersona(body, "openai", "ANCHOR")).not.toThrow();
  });
});

describe("precedenceAnchor", () => {
  it("names the callsign and asserts outranking", () => {
    const a = precedenceAnchor("BOZ-AGENT");
    expect(a).toContain("BOZ-AGENT");
    expect(a).toMatch(/outrank/i);
  });
});
