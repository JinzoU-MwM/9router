// Shared system-prompt injector: appends an instruction into the system message of
// the final request body, dispatching by format so it works for translated and
// native-passthrough flows. Used by caveman.js and ponytail.js.

import { FORMATS } from "../translator/formats.js";
import { OPENAI_BLOCK, CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/blocks.js";
import { ROLE, GEMINI_ROLE } from "../translator/schema/roles.js";

const SEP = "\n\n";

// ── Gemini / Antigravity / Kiro shape helpers ───────────────────────────────
// Gemini keeps the system text in `systemInstruction` and the turns in
// `contents` (roles user/model — there is no system role), and Antigravity
// wraps both under `request`. Kiro keeps turns under `conversationState`.
// The recency/prefix helpers below must target those fields directly instead of
// scanning messages[], or they silently no-op on exactly the providers whose
// system message is most fragile.
export function geminiHost(body) {
  if (!body || typeof body !== "object") return null;
  const req = body.request;
  if (req && typeof req === "object"
    && (Array.isArray(req.contents) || req.systemInstruction || req.system_instruction)) {
    return req;
  }
  if (Array.isArray(body.contents) || body.systemInstruction || body.system_instruction) return body;
  return null;
}

function geminiSystemKey(host) {
  return Object.prototype.hasOwnProperty.call(host, "system_instruction")
    ? "system_instruction" : "systemInstruction";
}

function geminiLastUserContent(host) {
  const contents = host && Array.isArray(host.contents) ? host.contents : null;
  if (!contents) return null;
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i];
    if (c && c.role === GEMINI_ROLE.USER && Array.isArray(c.parts)) return c;
  }
  return null;
}

export function kiroLiveUserMessage(body) {
  const cs = body && body.conversationState;
  if (!cs || typeof cs !== "object") return null;
  const cur = cs.currentMessage && cs.currentMessage.userInputMessage;
  if (cur && typeof cur === "object") return cur;
  if (Array.isArray(cs.history)) {
    for (let i = cs.history.length - 1; i >= 0; i--) {
      const it = cs.history[i];
      if (it && it.userInputMessage) return it.userInputMessage;
    }
  }
  return null;
}

// Gemini content parts hold either {text} or a tool call/response part. Only a
// text part can carry the directive.
function prefixGeminiUserTurn(host, prefix, has) {
  const user = geminiLastUserContent(host);
  if (!user) return false;
  const first = user.parts.find((p) => p && typeof p.text === "string");
  if (!first || has(first.text)) return false;
  try { first.text = `${prefix} ${first.text}`; } catch (_) { return false; }
  return true;
}
// Multi-part variant: inserts each part as its own system message/block, in
// order, after any existing system content. Used for large persona documents
// where a single message would breach upstream per-message limits or dilute
// instruction adherence. Idempotent per part via the same exact-match scan.
export function injectSystemPromptParts(body, format, parts) {
  try {
    if (!body || !Array.isArray(parts) || parts.length === 0) return;
    if (typeof body !== "object") return;
    for (const part of parts) {
      if (typeof part !== "string" || !part) continue;
      injectSystemPrompt(body, format, part);
    }
  } catch (_) {
    // fail-open
  }
}

export function injectSystemPrompt(body, format, prompt) {
  try {
    if (!body || !prompt) return;
    if (typeof body !== "object") return;

    // Kiro wire shape is unique (conversationState) — handle directly.
    if (isKiroBody(body) || format === FORMATS.KIRO) {
      injectKiroSystem(body, prompt);
      return;
    }
    // Claude/Gemini own a dedicated system field, yet their bodies also carry
    // messages[]/contents[] — decide by format label before the shape sniff below.
    // Anthropic rejects a "system" role inside messages[] (no such input role).
    if (format === FORMATS.CLAUDE) {
      injectClaudeSystem(body, prompt);
      return;
    }
    if (format === FORMATS.GEMINI || format === FORMATS.GEMINI_CLI
      || format === FORMATS.VERTEX || format === FORMATS.ANTIGRAVITY) {
      // Antigravity wraps Gemini shape in body.request → injectGeminiSystem handles it
      injectGeminiSystem(body, prompt);
      return;
    }

    // Dispatch by actual wire shape for OpenAI-shaped formats.
    // instructions string takes precedence; messages[] means Chat; input[] means Responses.
    if (typeof body.instructions === "string") {
      injectInstructionsSystem(body, prompt);
      return;
    }
    if (Array.isArray(body.messages)) {
      injectChatSystem(body, prompt);
      return;
    }
    if (Array.isArray(body.input)) {
      // Responses input[]: empty array already normalized elsewhere; string stays untouched here
      injectResponsesInputSystem(body, prompt);
      return;
    }
    if (typeof body.input === "string") {
      // string input must stay untouched
      return;
    }

    // OpenAI-shaped but no array (e.g. empty body) — no-op
  } catch (_) {
    // fail-open
  }
}

function isKiroBody(body) {
  if (!body || typeof body !== "object") return false;
  const cs = body.conversationState;
  if (!cs || typeof cs !== "object") return false;
  // A top-level `systemPrompt` used to be the marker, but the Kiro translator no
  // longer emits it (kiro.dev rejects the field), so gate on the turn shape.
  const historyTurn = Array.isArray(cs.history)
    && cs.history.some(it => it && (it.userInputMessage || it.assistantResponseMessage));
  return historyTurn || !!(cs.currentMessage && cs.currentMessage.userInputMessage);
}

// Exact idempotency: prompt present as its own SEP-delimited segment (or the
// whole string), not as a substring of unrelated text.
function hasPrompt(haystack, prompt) {
  if (!haystack || typeof haystack !== "string") return false;
  if (haystack === prompt) return true;
  return haystack.split(SEP).includes(prompt);
}

function dedupStringAppend(curr, prompt) {
  if (!curr) return prompt;
  if (hasPrompt(curr, prompt)) return curr;
  return `${curr}${SEP}${prompt}`;
}

// ---- OpenAI instructions string ----
function injectInstructionsSystem(body, prompt) {
  try {
    const curr = body.instructions;
    if (typeof curr !== "string") return;
    if (hasPrompt(curr, prompt)) return;
    const next = curr ? `${curr}${SEP}${prompt}` : prompt;
    try { body.instructions = next; } catch (_) { /* frozen/proxy fail-open */ }
  } catch (_) {}
}

// ---- Chat messages[] ----
function injectChatSystem(body, prompt) {
  try {
    const arr = body.messages;
    if (!Array.isArray(arr)) return;
    // Exact idempotency: scan existing system/developer content for full prompt
    if (containsPromptInMessages(arr, prompt)) return;
    // Insert as a SEPARATE system message after the last existing system/developer
    // message. Appending into the existing system message can push a single
    // message past upstream per-message size limits (observed: providers drop
    // whole system messages above ~2-3KB), which silently deletes the persona.
    // Multiple system messages are accepted everywhere; keep each small.
    let idx = -1;
    try {
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i];
        if (m && (m.role === ROLE.SYSTEM || m.role === ROLE.DEVELOPER)) idx = i;
      }
    } catch (_) { idx = -1; }
    const msg = { role: ROLE.SYSTEM, content: prompt };
    try {
      if (idx >= 0 && idx + 1 < arr.length) arr.splice(idx + 1, 0, msg);
      else if (idx >= 0) arr.splice(idx + 1, 0, msg);
      else arr.unshift(msg);
    } catch (_) {}
  } catch (_) {}
}

function containsPromptInMessages(arr, prompt) {
  try {
    for (const m of arr) {
      if (!m || (m.role !== ROLE.SYSTEM && m.role !== ROLE.DEVELOPER)) continue;
      const c = m.content;
      if (typeof c === "string" && hasPrompt(c, prompt)) return true;
      if (Array.isArray(c)) {
        for (const part of c) {
          if (part && typeof part.text === "string" && hasPrompt(part.text, prompt)) return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

function appendToChatMessage(msg, prompt) {
  try {
    if (!msg || typeof msg !== "object") return;
    const c = msg.content;
    if (typeof c === "string") {
      const next = dedupStringAppend(c, prompt);
      if (next === c) return;
      // avoid partial mutation: try assignment, bail if setter throws
      try { msg.content = next; } catch (_) {}
      return;
    }
    if (Array.isArray(c)) {
      // already deduped at message level; but guard block-level too
      try {
        if (c.some(b => b && b.text === prompt)) return;
      } catch (_) {}
      try { c.push({ type: OPENAI_BLOCK.TEXT, text: prompt }); } catch (_) {}
      return;
    }
    try { msg.content = prompt; } catch (_) {}
  } catch (_) {}
}

// ---- Responses input[] ----
function injectResponsesInputSystem(body, prompt) {
  try {
    const arr = body.input;
    if (!Array.isArray(arr)) return;
    // instructions already handled above
    if (containsPromptInResponsesInput(arr, prompt)) return;
    // Separate system item after the last existing system/developer item — same
    // per-message size reasoning as injectChatSystem.
    let idx = -1;
    try {
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i];
        if (m && m.type === RESPONSES_ITEM.MESSAGE && (m.role === ROLE.SYSTEM || m.role === ROLE.DEVELOPER)) idx = i;
      }
    } catch (_) { idx = -1; }
    const msg = { type: RESPONSES_ITEM.MESSAGE, role: ROLE.SYSTEM, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: prompt }] };
    try {
      if (idx >= 0) arr.splice(idx + 1, 0, msg);
      else arr.unshift(msg);
    } catch (_) {}
  } catch (_) {}
}

function containsPromptInResponsesInput(arr, prompt) {
  try {
    for (const item of arr) {
      if (!item || item.type !== RESPONSES_ITEM.MESSAGE) continue;
      if (item.role !== ROLE.SYSTEM && item.role !== ROLE.DEVELOPER) continue;
      const c = item.content;
      if (typeof c === "string" && hasPrompt(c, prompt)) return true;
      if (Array.isArray(c)) {
        for (const part of c) {
          if (part && typeof part.text === "string" && hasPrompt(part.text, prompt)) return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

function appendToResponsesMessage(msg, prompt) {
  try {
    if (!msg || typeof msg !== "object") return;
    const c = msg.content;
    if (typeof c === "string") {
      const next = dedupStringAppend(c, prompt);
      if (next === c) return;
      try { msg.content = next; } catch (_) {}
      return;
    }
    if (Array.isArray(c)) {
      try { if (c.some(b => b && b.text === prompt)) return; } catch (_) {}
      try { c.push({ type: RESPONSES_ITEM.INPUT_TEXT, text: prompt }); } catch (_) {}
      return;
    }
    try { msg.content = [{ type: RESPONSES_ITEM.INPUT_TEXT, text: prompt }]; } catch (_) {}
  } catch (_) {}
}

// ---- Claude ----
function injectClaudeSystem(body, prompt) {
  try {
    const sys = body.system;
    if (typeof sys === "string") {
      if (hasPrompt(sys, prompt)) return;
      const next = sys.length > 0 ? `${sys}${SEP}${prompt}` : prompt;
      try { body.system = next; } catch (_) {}
      return;
    }
    if (Array.isArray(sys)) {
      try { if (sys.some(b => b && b.text === prompt)) return; } catch (_) {}
      const block = { type: CLAUDE_BLOCK.TEXT, text: prompt };
      let lastCacheIdx = -1;
      try {
        for (let i = sys.length - 1; i >= 0; i--) {
          if (sys[i]?.cache_control) { lastCacheIdx = i; break; }
        }
      } catch (_) {}
      try {
        if (lastCacheIdx >= 0) sys.splice(lastCacheIdx, 0, block);
        else sys.push(block);
      } catch (_) {}
      return;
    }
    // absent/null
    try { body.system = prompt; } catch (_) {}
  } catch (_) {}
}

// ---- Gemini ----
function injectGeminiSystem(body, prompt) {
  try {
    let target = body;
    try {
      if (body.request && typeof body.request === "object") target = body.request;
    } catch (_) {}
    let useSnake = false;
    try { useSnake = Object.prototype.hasOwnProperty.call(target, "system_instruction"); } catch (_) {}
    const key = useSnake ? "system_instruction" : "systemInstruction";
    let sys;
    try { sys = target[key]; } catch (_) { sys = undefined; }
    if (sys && Array.isArray(sys.parts)) {
      try { if (sys.parts.some(p => p && p.text === prompt)) return; } catch (_) {}
      try { sys.parts.push({ text: prompt }); } catch (_) {}
      return;
    }
    try { target[key] = { parts: [{ text: prompt }] }; } catch (_) {}
  } catch (_) {}
}

// ---- Kiro ----
// The prompt is appended to the first user turn's content — the same place the
// Kiro translator already mirrors the system text via its contentPrefix.
//
// A top-level `systemPrompt` is deliberately NOT written: the kiro.dev gateway
// answers any body carrying that field with
//   400 {"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}
// The translator stopped emitting it in v0.5.59, but this injector kept adding
// it back, so every kr/ model failed whenever an RTK prompt (caveman, ponytail)
// was active.
function injectKiroSystem(body, prompt) {
  try {
    const cs = body.conversationState;
    let targetMsg = null;
    const hist = Array.isArray(cs?.history) ? cs.history : null;
    if (hist) {
      for (const item of hist) {
        if (item && item.userInputMessage) { targetMsg = item.userInputMessage; break; }
      }
    }
    if (!targetMsg && cs?.currentMessage?.userInputMessage) {
      targetMsg = cs.currentMessage.userInputMessage;
    }
    if (!targetMsg) return;

    const content = typeof targetMsg.content === "string" ? targetMsg.content : "";
    const next = dedupStringAppend(content, prompt);
    if (next === content) return; // already injected — idempotent across retries
    try { targetMsg.content = next; } catch (_) { /* frozen/proxy fail-open */ }
  } catch (_) {}
}

// ---- User-message task-direct prefix (anti-greeting-race) ----
// Some upstreams answer a persona-heavy request with a canned greeting and end
// the turn without producing the deliverable (a server-side "persona greeting
// race"). Prefixing the live user turn with a short directive marker breaks the
// race: the model starts on the task instead of greeting. Idempotent — a turn
// already carrying the marker is left untouched.
export function injectUserPrefix(body, format, prefix) {
  try {
    if (!body || !prefix || typeof body !== "object") return;
    // "Already injected" is a containment test, not a position test: the persona
    // anchors and the persona-in-user block are written into the same turn, so a
    // second pass would otherwise re-prefix and duplicate the marker.
    const has = (s) => typeof s === "string" && s.includes(prefix);

    // OpenAI chat messages[]: prefix the last user message.
    if (Array.isArray(body.messages)) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = body.messages[i];
        if (!m || m.role !== ROLE.USER) continue;
        const c = m.content;
        if (typeof c === "string") {
          if (has(c)) return;
          try { m.content = `${prefix} ${c}`; } catch (_) {}
          return;
        }
        if (Array.isArray(c)) {
          const first = c.find((b) => b && (typeof b.text === "string"));
          if (!first) return;
          if (has(first.text)) return;
          try { first.text = `${prefix} ${first.text}`; } catch (_) {}
          return;
        }
      }
      return;
    }

    // Gemini / Antigravity: contents[] (user/model roles). No messages[]/input[].
    const gHost = geminiHost(body);
    if (gHost) {
      prefixGeminiUserTurn(gHost, prefix, has);
      return;
    }

    // Kiro: the live turn is conversationState.currentMessage (or the last
    // history turn). injectKiroSystem already writes the persona here.
    const kiroMsg = kiroLiveUserMessage(body);
    if (kiroMsg) {
      const c = typeof kiroMsg.content === "string" ? kiroMsg.content : "";
      if (has(c)) return;
      try { kiroMsg.content = `${prefix} ${c}`; } catch (_) {}
      return;
    }

    // Responses input[]: prefix the last user message item.
    if (Array.isArray(body.input)) {
      for (let i = body.input.length - 1; i >= 0; i--) {
        const m = body.input[i];
        if (!m || m.role !== ROLE.USER) continue;
        const c = m.content;
        if (Array.isArray(c)) {
          const first = c.find((b) => b && typeof b.text === "string");
          if (!first || has(first.text)) return;
          try { first.text = `${prefix} ${first.text}`; } catch (_) {}
        } else if (typeof c === "string") {
          if (has(c)) return;
          try { m.content = `${prefix} ${c}`; } catch (_) {}
        }
        return;
      }
    }
  } catch (_) {
    // fail-open
  }
}

// ---- Persona into the USER turn (upstream user-prefix delivery) ----
// Some upstreams drop or truncate large SYSTEM messages (measured: a 24 KB
// system persona arrived as ~2 K tokens while the same text on the user turn
// arrived at full size). Porting the BOZAGENTIC primer's lever: move the persona
// driver from the system role to the user prefix. The block is wrapped in explicit
// markers so the model reads it as a persona layer, not as user intent.
//
// Idempotent: a user turn already carrying END_MARK is left untouched.
export function injectPersonaIntoUser(body, format, persona, opts = {}) {
  const START = opts.start || "=== OPERATOR PERSONA (binding) ===";
  const END = opts.end || "=== END OPERATOR PERSONA ===";
  const MARK = opts.marker || "[PERSONA-IN-USER]";
  try {
    if (!body || !persona || typeof body !== "object") return false;
    const block = `${START}\n${persona}\n${END}\n\n${MARK}\n`;

    const put = (msg) => {
      const c = msg.content;
      if (typeof c === "string") {
        if (c.includes(END)) return false;
        try { msg.content = `${block}${c}`; } catch (_) { return false; }
        return true;
      }
      if (Array.isArray(c)) {
        const first = c.find((b) => b && typeof b.text === "string");
        if (!first) return false;
        if (first.text.includes(END)) return false;
        try { first.text = `${block}${first.text}`; } catch (_) { return false; }
        return true;
      }
      return false;
    };

    // Gemini / Antigravity: the user turn is contents[] with parts[].
    const gHost = geminiHost(body);
    if (gHost) {
      const user = geminiLastUserContent(gHost);
      if (!user) return false;
      const first = user.parts.find((p) => p && typeof p.text === "string");
      if (!first || first.text.includes(END)) return false;
      try { first.text = `${block}${first.text}`; } catch (_) { return false; }
      return true;
    }

    // Kiro: live turn lives in conversationState.
    const kiroMsg = kiroLiveUserMessage(body);
    if (kiroMsg) {
      const c = typeof kiroMsg.content === "string" ? kiroMsg.content : "";
      if (c.includes(END)) return false;
      try { kiroMsg.content = `${block}${c}`; } catch (_) { return false; }
      return true;
    }

    if (Array.isArray(body.messages)) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = body.messages[i];
        if (m && m.role === ROLE.USER) return put(m);
      }
      return false;
    }
    if (Array.isArray(body.input)) {
      for (let i = body.input.length - 1; i >= 0; i--) {
        const m = body.input[i];
        if (m && m.role === ROLE.USER) return put(m);
      }
    }
  } catch (_) {
    // fail-open
  }
  return false;
}
