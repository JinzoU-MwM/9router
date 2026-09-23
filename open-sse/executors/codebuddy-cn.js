import { DefaultExecutor } from "./default.js";

/**
 * CodeBuddyExecutor — talks to https://copilot.tencent.com/v2/chat/completions
 *
 * CodeBuddy is OpenAI-compatible but rejects non-stream chat requests
 * (HTTP 400, code 11101 "Non-stream chat request is currently not supported").
 * The same-format (openai→openai) translator path leaves body.stream as the
 * client sent it, so we force it true here — 9router still re-aggregates the
 * SSE into a JSON response for non-streaming clients.
 */
export class CodeBuddyExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-cn");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    // Tencent's content filter flags CLI agent system prompts ("You are Claude
    // Code, Anthropic's official CLI...") as prompt injection / sensitive content
    // and rejects the whole request. Rewriting the caller's system prompt to dodge
    // that filter is a silent, lossy workaround: it changes agent behavior and
    // hides the real failure, so it is OFF by default and must be opted into per
    // connection:
    //   providerSpecificData: { neutralizeAgentPrompt: true }
    // When enabled, detection is unchanged — agent identity markers (regex) plus a
    // length catch-all — while legitimate short user prompts stay untouched.
    // content may be a string or typed blocks ([{type:"text",text}]) depending on
    // the incoming client format, so flatten before matching and preserve the
    // original shape on replacement.
    if (credentials?.providerSpecificData?.neutralizeAgentPrompt === true) {
      const NEUTRAL_PROMPT = "You are a helpful AI assistant that helps with software engineering tasks.";
      const AGENT_PATTERN = /you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|anxthxropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|you are an? (?:ai )?(?:coding |code )?agent|cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)|claude.?code.+issues|give feedback.+claude.?code|you are .{0,30}(?:powerful )?ai agent|orchestration capabilities|OhMyOpenCode|<agent-identity>|<Role>|<Behavior_Instructions>/i;
      const flatten = (content) =>
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n")
            : "";
      if (Array.isArray(transformed.messages)) {
        transformed.messages = transformed.messages.map((message) => {
          if (!message || message.role !== "system") return message;
          const text = flatten(message.content);
          if (!text) return message;
          if (text.length > 2000 || AGENT_PATTERN.test(text)) {
            return typeof message.content === "string"
              ? { ...message, content: NEUTRAL_PROMPT }
              : { ...message, content: [{ type: "text", text: NEUTRAL_PROMPT }] };
          }
          return message;
        });
      }
    }

    // CodeBuddy only surfaces model reasoning when the request carries the CLI's
    // OpenAI-style params: reasoning_effort + reasoning_summary:"auto". 9router's
    // thinking pipeline sets reasoning_effort only when the client asks, and never
    // sets reasoning_summary — so reasoning never shows. Mirror the CLI here.
    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort; // gateway has no "none" — just omit
    } else if (eff) {
      // Client explicitly asked for reasoning — mirror the CLI's reasoning_summary
      // so CodeBuddy surfaces the model's reasoning.
      transformed.reasoning_summary = "auto";
    }
    // No reasoning requested: leave both unset. Forcing reasoning_effort:"medium"
    // + reasoning_summary on plain requests makes CodeBuddy trip its content
    // filter and return an error (#2071).
    return transformed;
  }
}

export default CodeBuddyExecutor;
