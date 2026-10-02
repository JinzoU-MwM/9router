/**
 * Liveness probe for a single bansos credential.
 *
 * Cheap by design: it asks /models first, because a sweep runs over hundreds of
 * shared keys and a chat completion would burn quota on every one of them. Only
 * when the relay has no /models endpoint does it fall back to a 1-token chat
 * call, which is the smallest request that still proves the key authorises.
 *
 * Never throws: a network failure is a result too (status 0), because the
 * sweeper has to tell "this key is dead" apart from "this relay is unreachable".
 */

const DEFAULT_TIMEOUT_MS = 8000;

function headersFor(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function call(url, init, timeoutMs) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    let body = "";
    try {
      body = (await res.text()).slice(0, 500);
    } catch {
      body = "";
    }
    return { status: res.status, errorText: body };
  } catch (error) {
    const name = error?.name || "";
    const msg = name === "TimeoutError" || name === "AbortError" ? "probe timeout" : String(error?.message || error);
    return { status: 0, errorText: msg };
  }
}

/**
 * @returns {Promise<{ok: boolean, status: number, errorText: string, via: "models"|"chat"|"none"}>}
 */
export async function probeConnection({ baseUrl, apiKey, model, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base || !apiKey) return { ok: false, status: 0, errorText: "missing base url or api key", via: "none" };

  const models = await call(`${base}/models`, { method: "GET", headers: headersFor(apiKey) }, timeoutMs);
  // 200 = the relay lists models. 400 also proves the key was accepted (bad
  // request, not bad auth) — the same convention testUtils.js uses.
  if (models.status === 200 || models.status === 400) {
    return { ok: true, status: models.status, errorText: models.errorText, via: "models" };
  }
  // A relay without /models: only then spend a real (1-token) completion.
  if ([401, 402, 403, 429].includes(models.status)) {
    return { ok: false, status: models.status, errorText: models.errorText, via: "models" };
  }

  const chat = await call(
    `${base}/chat/completions`,
    {
      method: "POST",
      headers: headersFor(apiKey),
      body: JSON.stringify({
        model: model || "gpt-3.5-turbo",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
    },
    timeoutMs
  );
  if (chat.status === 200 || chat.status === 400) {
    return { ok: true, status: chat.status, errorText: chat.errorText, via: "chat" };
  }
  return { ok: false, status: chat.status, errorText: chat.errorText, via: "chat" };
}
