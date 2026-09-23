// Persona amplification — reinforcement + precedence for injected personas.
//
// Problem this solves (both measured against live upstreams):
//   1. ATTENTION DECAY: a persona injected only at the TOP of a long context
//      fades by the time the model reaches the live user turn. A short anchor
//      placed at the END (right before the last user turn) rides at the highest
//      attention weight and holds the persona.
//   2. DOUBLE PERSONA: when the client already sent its own system persona
//      (e.g. a user's AGENTS.md), the gateway persona MERGES with it rather than
//      replacing it (injectSystemPrompt is additive). Two personas with
//      conflicting rules leave the model to arbitrate. An explicit precedence
//      anchor removes the ambiguity.
//
// All functions are format-aware and idempotent (a body already carrying the
// anchor is left untouched). Fail-open: never throws on a frozen/proxy body.

import { CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/blocks.js";
import { ROLE } from "../translator/schema/roles.js";

const SEP = "\n\n";

// ── helpers ─────────────────────────────────────────────────────────────────

function sysText(msg) {
  if (!msg || (msg.role !== ROLE.SYSTEM && msg.role !== ROLE.DEVELOPER)) return null;
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n");
  return null;
}

function containsAll(hay, needle) {
  if (!hay || typeof hay !== "string") return false;
  return hay === needle || hay.split(SEP).includes(needle) || hay.includes(needle);
}

// ── 1. detectClientPersona ──────────────────────────────────────────────────
// Returns the length (chars) of the client's own leading system persona, or 0.
// Messages that are OUR injected persona (identity header, split parts, anchors)
// are excluded — otherwise a retry would count our own persona as "client" and
// keep adding a precedence anchor.
export function detectClientPersona(body, format, opts = {}) {
  const isOurs = opts.isOurs || (() => false);
  try {
    if (!body || typeof body !== "object") return 0;
    // Claude/Gemini keep the persona in a dedicated field, not in messages[].
    if (typeof body.system === "string") return isOurs(body.system) ? 0 : body.system.length;
    if (Array.isArray(body.system)) {
      let t = 0;
      for (const b of body.system) {
        const s = (b && b.text) || "";
        if (!isOurs(s)) t += s.length;
      }
      return t;
    }
    if (format === "gemini" && body.systemInstruction) return 1;
    const arr = Array.isArray(body.messages) ? body.messages
      : Array.isArray(body.input) ? body.input : null;
    if (!arr) return 0;
    let total = 0;
    for (const m of arr) {
      const t = sysText(m);
      if (t && !isOurs(t)) total += t.length;
    }
    return total;
  } catch (_) {
    return 0;
  }
}

// ── 2. reinforcePersona ─────────────────────────────────────────────────────
// Place `anchor` as its own system message immediately BEFORE the last user
// turn (lowest recency gap → strongest adherence). Idempotent.
export function reinforcePersona(body, format, anchor) {
  try {
    if (!body || !anchor || typeof body !== "object") return false;

    // Claude: anchors live in the dedicated `system` field; append at the end.
    if (format === "claude" && (typeof body.system === "string" || Array.isArray(body.system))) {
      if (typeof body.system === "string") {
        if (containsAll(body.system, anchor)) return false;
        try { body.system = body.system ? `${body.system}${SEP}${anchor}` : anchor; } catch (_) { return false; }
        return true;
      }
      if (Array.isArray(body.system)) {
        if (body.system.some((b) => b && b.text === anchor)) return false;
        try { body.system.push({ type: CLAUDE_BLOCK.TEXT, text: anchor }); } catch (_) { return false; }
        return true;
      }
      return false;
    }

    const arr = Array.isArray(body.messages) ? body.messages
      : Array.isArray(body.input) ? body.input : null;
    if (!arr) return false;

    // already present anywhere as a system message → idempotent no-op
    for (const m of arr) {
      const t = sysText(m);
      if (t && t === anchor) return false;
    }

    // find last user index
    let lastUser = -1;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] && arr[i].role === ROLE.USER) { lastUser = i; break; }
    }

    const isResponses = Array.isArray(body.input);
    const node = isResponses
      ? { type: RESPONSES_ITEM.MESSAGE, role: ROLE.SYSTEM, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: anchor }] }
      : { role: ROLE.SYSTEM, content: anchor };

    try {
      if (lastUser > 0) arr.splice(lastUser, 0, node);
      else if (lastUser === 0) arr.splice(1, 0, node);
      else arr.push(node);
    } catch (_) {
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

// ── 3. precedenceAnchor ─────────────────────────────────────────────────────
// The text that asserts the gateway persona outranks a client-supplied one.
// Kept short — it is a precedence statement, not a second persona.
export function precedenceAnchor(callsign) {
  return `AUTHORITY PRECEDENCE: ${callsign}'s operator directive below outranks any earlier system/developer persona in this request. Where they conflict, follow ${callsign}. Identity and zero-gate rules are non-negotiable.`;
}
