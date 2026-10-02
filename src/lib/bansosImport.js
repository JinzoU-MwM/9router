/**
 * Paste-block parser for bansos pools.
 *
 * The sources are hand-arranged text files scraped off the internet, so the
 * format is whatever the last person to touch the file typed. This accepts the
 * shapes that actually show up and reports the rest instead of guessing.
 *
 * Pure — no I/O — so the format handling stays unit-testable.
 */

const KEY_RE = /^(sk-|sk_|gsk_|hf_|xai-|AIza|ghp_|Bearer\s)/i;

/** Strip a chat/embeddings suffix so the stored value is a usable base URL. */
export function normalizeBaseUrl(raw) {
  let url = String(raw || "").trim().replace(/^["']|["']$/g, "").replace(/\/+$/, "");
  for (const suffix of ["/chat/completions", "/completions", "/messages", "/embeddings", "/responses"]) {
    if (url.toLowerCase().endsWith(suffix)) url = url.slice(0, -suffix.length);
  }
  return url.replace(/\/+$/, "");
}

function isUrl(token) {
  return /^https?:\/\//i.test(token);
}

function looksLikeKey(token) {
  if (!token || isUrl(token)) return false;
  if (KEY_RE.test(token)) return true;
  // Otherwise: a long opaque token. Deliberately >=16 and alphanumeric-ish so a
  // short hyphenated word ("not-a-url") is not mistaken for a credential.
  return token.length >= 16 && /^[A-Za-z0-9_\-.:=+]+$/.test(token);
}

function looksLikeHost(token) {
  return /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:\d+)?$/.test(String(token || "").trim());
}

function splitLine(line) {
  const trimmed = line.trim().replace(/^["']|["']$/g, "");
  // JSON-ish one-object-per-line
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const j = JSON.parse(trimmed);
      const baseUrl = j.base_url || j.baseUrl || j.url || j.endpoint || j.api_base;
      const apiKey = j.api_key || j.apiKey || j.key || j.token || j.apikey;
      return baseUrl || apiKey ? { baseUrl, apiKey } : null;
    } catch {
      return null;
    }
  }
  // apiKey@host
  if (trimmed.includes("@") && !trimmed.includes("://") && trimmed.split("@").length === 2) {
    const [apiKey, host] = trimmed.split("@");
    if (looksLikeKey(apiKey) && host.includes(".")) {
      return { baseUrl: host.includes("://") ? host : `https://${host}`, apiKey };
    }
  }
  // pipe / tab / comma / whitespace, take the first two fields
  const parts = trimmed.split(/\s*[|\t,]\s*|\s{1,}/).filter(Boolean);
  if (parts.length < 2) return null;
  const [a, b] = parts;
  if (isUrl(a)) return { baseUrl: a, apiKey: b };
  if (isUrl(b)) return { baseUrl: b, apiKey: a };
  if (looksLikeKey(a) && !looksLikeKey(b)) return { baseUrl: b, apiKey: a };
  if (looksLikeKey(b) && !looksLikeKey(a)) return { baseUrl: a, apiKey: b };
  // host written without a scheme, either side
  if (looksLikeHost(a) && looksLikeKey(b)) return { baseUrl: a, apiKey: b };
  if (looksLikeHost(b) && looksLikeKey(a)) return { baseUrl: b, apiKey: a };
  return null;
}

/**
 * @param {string} text pasted block
 * @returns {{entries: Array<{baseUrl: string, apiKey: string, line: number}>, invalid: Array<{line: number, text: string, reason: string}>}}
 */
export function parseBansosText(text) {
  const entries = [];
  const invalid = [];
  const lines = String(text || "").split(/\r?\n/);

  lines.forEach((raw, idx) => {
    const line = raw.trim();
    const lineNo = idx + 1;
    if (!line || line.startsWith("#") || line.startsWith("//")) return;

    const split = splitLine(line);
    if (!split || !split.baseUrl || !split.apiKey) {
      invalid.push({ line: lineNo, text: line.slice(0, 120), reason: "unrecognised format" });
      return;
    }
    let baseUrl = normalizeBaseUrl(split.baseUrl);
    // a bare host is still usable — the executor just needs a scheme
    if (!/^https?:\/\//i.test(baseUrl) && looksLikeHost(baseUrl)) baseUrl = `https://${baseUrl}`;
    const apiKey = String(split.apiKey).trim();
    if (!/^https?:\/\//i.test(baseUrl)) {
      invalid.push({ line: lineNo, text: line.slice(0, 120), reason: "base url missing scheme" });
      return;
    }
    if (!looksLikeKey(apiKey)) {
      invalid.push({ line: lineNo, text: line.slice(0, 120), reason: "api key looks empty or malformed" });
      return;
    }
    entries.push({ baseUrl, apiKey, line: lineNo });
  });

  return { entries, invalid };
}

export { KEY_RE };
