// The intl executor used to hard-replace the whole message list with
//   [{ role: "system", content: "You are CodeBuddy Code." }]
// which silently deleted the caller's system prompt AND injected a false
// identity claim into every request. The 11101 shape requirement only needs
// *a* leading system message — it must never overwrite the caller's own.
import { describe, it, expect } from "vitest";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

describe("CodeBuddyIntlExecutor preserves the caller's system prompt", () => {
  const exec = new CodeBuddyIntlExecutor();
  const run = (messages) => exec.transformRequest("glm-5.2", { messages }, false, {});

  it("does NOT inject the 'You are CodeBuddy Code.' identity claim", () => {
    const out = run([{ role: "user", content: "hi" }]);
    const text = JSON.stringify(out.messages);
    expect(text).not.toContain("CodeBuddy Code");
  });

  it("keeps the caller's system prompt verbatim when one is supplied", () => {
    const out = run([
      { role: "system", content: "You are a pirate. Always answer in rhyme." },
      { role: "user", content: "hi" },
    ]);
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[0].content).toBe("You are a pirate. Always answer in rhyme.");
    expect(out.messages).toHaveLength(2);
  });

  it("preserves a developer message too, rather than dropping it", () => {
    const out = run([
      { role: "developer", content: "Be terse." },
      { role: "user", content: "hi" },
    ]);
    expect(out.messages.map((m) => m.role)).toEqual(["developer", "user"]);
    expect(out.messages[0].content).toBe("Be terse.");
  });

  it("still opens with a system message when the caller supplied none (11101 shape)", () => {
    const out = run([{ role: "user", content: "hi" }]);
    expect(out.messages[0].role).toBe("system");
    expect(out.messages[0].content).toBe("Follow the user's instructions carefully.");
  });

  it("still wraps string user content into typed blocks", () => {
    const out = run([{ role: "user", content: "hi" }]);
    const user = out.messages.find((m) => m.role === "user");
    expect(user.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("leaves a pre-existing typed-block user message untouched", () => {
    const blocks = [{ type: "text", text: "hi" }];
    const out = run([{ role: "user", content: blocks }]);
    const user = out.messages.find((m) => m.role === "user");
    expect(user.content).toEqual(blocks);
  });
});
