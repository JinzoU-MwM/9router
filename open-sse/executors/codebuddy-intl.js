import { DefaultExecutor } from "./default.js";

// CodeBuddy's gateway answers bodies that don't open with a system message with
// 400 {"code":11101} — a transport shape requirement, nothing more. This string
// satisfies that shape and carries NO identity claim; it is used ONLY when the
// caller supplied no system/developer message of their own. The caller's own
// system prompt is always preserved verbatim when present.
const LEADING_SYSTEM_PLACEHOLDER = "Follow the user's instructions carefully.";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): the body
    // must open with a system prompt and carry user content as typed blocks,
    // not a bare string. Normalize the shape only — never overwrite or drop
    // the caller's own system/developer messages.
    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    const normalized = [];
    for (const message of source) {
      if (!message || typeof message !== "object") continue;
      if (message.role === "user" && typeof message.content === "string") {
        normalized.push({ ...message, content: [{ type: "text", text: message.content }] });
      } else {
        normalized.push({ ...message });
      }
    }
    const first = normalized[0];
    const opensWithSystem = !!first && (first.role === "system" || first.role === "developer");
    transformed.messages = opensWithSystem
      ? normalized
      : [{ role: "system", content: LEADING_SYSTEM_PLACEHOLDER }, ...normalized];

    return transformed;
  }
}

export default CodeBuddyIntlExecutor;
