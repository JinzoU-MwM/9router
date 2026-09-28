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
  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const msg = data?.msg || data?.message || data?.error?.message || "";
        if (data?.code === 6004 || /超出频率限制|frequency limit|限额/i.test(msg)) {
          let resetsAtMs = null;
          const match = msg.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i);
          if (match) {
            const dp = match[1];
            const tp = match[2];
            const tz = match[3]
              ? (match[3].includes(":") ? (match[3].startsWith("+") ? match[3] : `+${match[3]}`) : `+${match[3].padStart(2, "0")}:00`)
              : "+08:00";
            const dt = new Date(`${dp}T${tp}${tz}`);
            if (!isNaN(dt.getTime())) resetsAtMs = dt.getTime();
          }
          return {
            status: 429,
            message: msg || "CodeBuddy frequency limit (6004)",
            resetsAtMs,
          };
        }
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyIntlExecutor;
