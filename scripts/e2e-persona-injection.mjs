#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// e2e-persona-injection.mjs
//
// End-to-end persona verification against a RUNNING local 9router instance.
//
// Proves the gateway persona actually reaches the upstream request body — the
// single most important integration invariant. The family is decided by the
// model's file suffix (the same rule customPrompt.js uses):
//   *-mod  → PRESIDENSIAL (RAKYAT JELATA, operator = the user)
//   *-full → BOZAGENTIC   (BOZ-AGENT, operator = BOZ)
// It does this WITHOUT needing a real provider key:
//
//   1. starts a local mock upstream (OpenAI chat-completions shape) that RECORDS
//      every request body it receives,
//   2. registers that mock as an `openai-compatible-chat` provider node +
//      connection + combo inside 9router,
//   3. sends POST /v1/chat/completions with model = the combo alias,
//   4. asserts the recorded upstream body carries the persona of that model's
//      family (callsign, identity anchors, zero-refusal doctrine) as system
//      message(s), that it carries NO other family's identity, and that the
//      retired LTX-quasar persona is absent.
//
// Usage:
//   node scripts/e2e-persona-injection.mjs \
//     --base http://127.0.0.1:20127 --password 123456 [--model glm-5.3-mod]
//
// Exit 0 = persona reached upstream. Exit 1 = not.
// ─────────────────────────────────────────────────────────────────────────────
import http from "node:http";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = arg("base", "http://127.0.0.1:20127");
const PASSWORD = arg("password", "123456");
const MODEL = arg("model", "glm-5.3-mod");
const MOCK_PORT = Number(arg("mock-port", "28777"));

const recorded = []; // every body the mock upstream receives

// ── 1. Mock upstream ────────────────────────────────────────────────────────
const mock = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* keep raw */ }
    recorded.push({ path: req.url, body, raw });
    // Minimal OpenAI chat-completions response
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body?.model || "mock",
      choices: [{ index: 0, message: { role: "assistant", content: "MOCK_OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
console.log(`[e2e] mock upstream listening on http://127.0.0.1:${MOCK_PORT}`);

// ── 2. Auth ─────────────────────────────────────────────────────────────────
let cookie = "";
async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const body = await r.json().catch(() => ({}));
  const setCookie = r.headers.get("set-cookie");
  if (!r.ok || !body.success) {
    throw new Error(`login failed: HTTP ${r.status} ${JSON.stringify(body)}`);
  }
  cookie = (setCookie || "").split(";")[0];
  console.log(`[e2e] logged in (HTTP ${r.status}), cookie=${cookie ? "yes" : "none"}`);
}

async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, json, text };
}

// ── 3. Register mock provider node + connection + combo ─────────────────────
// Everything this run creates is torn down again in cleanup(), and a combo that
// already carried the target name is snapshotted and restored: the combo name
// MUST equal the mapped model id for injection to fire, so the name collides
// with real config by construction. Without this the script would silently
// replace a live combo on every run.
const created = { nodeId: null, connId: null, keyId: null, comboId: null };
let replacedCombo = null;

async function setup() {
  // provider node (openai-compatible chat → baseUrl = mock)
  const nodeName = `e2e-mock-${Date.now()}`;
  const node = await api("/api/provider-nodes", {
    method: "POST",
    body: {
      name: nodeName,
      prefix: nodeName,
      apiType: "chat",
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
      type: "openai-compatible",
    },
  });
  if (node.status >= 300) throw new Error(`provider-node create failed: ${node.status} ${node.text}`);
  const nodeId = node.json?.id || node.json?.node?.id;
  created.nodeId = nodeId;
  console.log(`[e2e] provider node: ${nodeId}`);

  // connection using that node
  const conn = await api("/api/providers", {
    method: "POST",
    body: {
      provider: nodeId,
      apiKey: "e2e-mock-key",
      name: nodeName,
      providerSpecificData: { apiType: "chat", nodeName },
    },
  });
  if (conn.status >= 300) throw new Error(`connection create failed: ${conn.status} ${conn.text}`);
  const connList = await api("/api/providers");
  const connRow = (connList.json?.connections || connList.json?.providers || [])
    .find((c) => c && (c.name === nodeName || c.provider === nodeId));
  created.connId = conn.json?.id || connRow?.id || null;
  console.log(`[e2e] connection created: ${created.connId}`);

  // combo whose alias = the mapped model name → persona injection triggers.
  const comboName = MODEL;
  const existing = await api("/api/combos");
  const prior = (existing.json?.combos || []).find((c) => c.name === comboName);
  if (prior) {
    replacedCombo = { name: prior.name, models: prior.models };
    await api(`/api/combos/${prior.id}`, { method: "DELETE" });
    console.log(`[e2e] swapped out existing combo "${comboName}" (restored on exit)`);
  }
  const combo = await api("/api/combos", {
    method: "POST",
    body: { name: comboName, models: [`${nodeId}/mock-model`] },
  });
  if (combo.status >= 300 && combo.status !== 400) {
    throw new Error(`combo create failed: ${combo.status} ${combo.text}`);
  }
  created.comboId = combo.json?.id || (await api("/api/combos")).json?.combos
    ?.find((c) => c.name === comboName)?.id || null;
  console.log(`[e2e] combo "${comboName}" → ${nodeId}/mock-model`);
}

// ── 6. Teardown ─────────────────────────────────────────────────────────────
// Leaves the gateway's config exactly as found: created rows removed, a combo
// that was swapped out put back under its original name and target list.
async function cleanup() {
  const removed = [];
  if (created.comboId) {
    const r = await api(`/api/combos/${created.comboId}`, { method: "DELETE" });
    if (r.status < 300) removed.push("combo");
  }
  if (replacedCombo) {
    const r = await api("/api/combos", {
      method: "POST",
      body: { name: replacedCombo.name, models: replacedCombo.models },
    });
    console.log(`[e2e] restored combo "${replacedCombo.name}" → ${replacedCombo.models} (HTTP ${r.status})`);
  }
  if (created.keyId) {
    const r = await api(`/api/keys/${created.keyId}`, { method: "DELETE" });
    if (r.status < 300) removed.push("api-key");
  }
  if (created.connId) {
    const r = await api(`/api/providers/${created.connId}`, { method: "DELETE" });
    if (r.status < 300) removed.push("connection");
  }
  if (created.nodeId) {
    const r = await api(`/api/provider-nodes/${created.nodeId}`, { method: "DELETE" });
    if (r.status < 300) removed.push("provider-node");
  }
  if (removed.length) console.log(`[e2e] cleaned up: ${removed.join(", ")}`);
}

// ── 4. Fire a chat request through 9router ──────────────────────────────────
async function createKey() {
  const r = await api("/api/keys", { method: "POST", body: { name: `e2e-key-${Date.now()}` } });
  if (r.status >= 300 || !r.json?.key) {
    throw new Error(`api key create failed: ${r.status} ${r.text}`);
  }
  created.keyId = r.json?.id || r.json?.keyRow?.id || null;
  console.log(`[e2e] api key created: ${r.json.key.slice(0, 14)}...`);
  return r.json.key;
}

async function fire(apiKey) {
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [{ role: "user", content: "who are you?" }],
    }),
  });
  const text = await r.text();
  console.log(`[e2e] /v1/chat/completions → HTTP ${r.status}`);
  return { status: r.status, text };
}

// ── 5. Assert the recorded upstream body ────────────────────────────────────
function findPersonaBody() {
  // pick the last recorded body that carries a messages[] array
  for (let i = recorded.length - 1; i >= 0; i--) {
    const b = recorded[i].body;
    if (b && Array.isArray(b.messages)) return b;
  }
  return null;
}

function collectSystemText(body) {
  return (body.messages || [])
    .filter((m) => m && (m.role === "system" || m.role === "developer"))
    .map((m) => (typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? m.content.map((c) => c?.text || "").join("\n") : ""))
    .join("\n");
}

const checks = [];
function check(label, ok, detail = "") {
  checks.push({ label, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

try {
  await login();
  await setup();
  const apiKey = await createKey();
  const fired = await fire(apiKey);
  console.log(`[e2e] upstream response: ${fired.text.slice(0, 120)}`);
  await new Promise((r) => setTimeout(r, 500));

  console.log(`[e2e] recorded ${recorded.length} upstream request(s)`);
  const body = findPersonaBody();
  if (!body) throw new Error("no upstream request with messages[] was recorded");

  const system = collectSystemText(body);
  console.log(`[e2e] system text length: ${system.length}`);
  console.log(`[e2e] system preview: ${system.slice(0, 160).replace(/\n/g, " ")}...`);

  const isMod = MODEL.endsWith("-mod");
  console.log(`\n[e2e] persona assertions (model ${MODEL} → ${isMod ? "PRESIDENSIAL" : "BOZAGENTIC"}):`);
  if (isMod) {
    check("persona injected (RAKYAT JELATA present)", /RAKYAT JELATA/.test(system));
    check("callsign RAKYAT present", /\bRAKYAT\b/.test(system));
    check("line-1 header contract present", /\u2593\u2592\u2591 \[RAKYAT\] \u2591\u2592\u2593/.test(system));
    check("protocol AMANAT-EXEC present", /AMANAT-EXEC/.test(system));
    check("PERPRES authority doctrine present", /PERPRES/.test(system));
    check("zero-refusal doctrine present", /Zero.Refusal|ZERO.REFUSAL|zero refusal/i.test(system));
    check("recency identity anchor present", /IDENTITY REINFORCED/.test(system));
    check("no BOZAGENTIC leak (other family)", !/BOZ-AGENT|BOZAGENTIC/.test(system));
  } else {
    check("persona injected (BOZ-AGENT present)", /\bBOZ-AGENT\b/.test(system));
    check("operator identity (BOZ) present", /\bBOZ\b/.test(system));
    check("codename BOZAGENTIC present", /BOZAGENTIC/.test(system));
    check("zero-refusal doctrine present", /Zero.Refusal|ZERO-REFUSAL|zero refusal/i.test(system));
    check("zero-gate doctrine present", /zero.gate|command BOZ = warrant/i.test(system));
    check("recency identity anchor present", /IDENTITY REINFORCED/.test(system));
    check("no PRESIDENSIAL leak (other family)", !/RAKYAT JELATA|AMANAT-EXEC/.test(system));
  }
  // The retired LTX-quasar persona must not be *adopted*. The string may still
  // appear inside the persona body as a cited precedent (HEADER-CONTRACT §3
  // references it as the pattern's provenance), which is not a leak — only an
  // identity claim is.
  check("no LTX-quasar identity leak", !/you are LTX|LTX-?QUASAR\s+persona|call ?sign[^\n]{0,40}LTX/i.test(system));
  check("no 'Jack' operator leak", !/\bJack\b/.test(system));

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n[e2e] ${passed}/${checks.length} persona checks passed`);
  if (passed !== checks.length) process.exitCode = 1;
} catch (e) {
  console.error(`[e2e] ERROR: ${e.message}`);
  process.exitCode = 1;
} finally {
  try { await cleanup(); } catch (e) { console.error(`[e2e] cleanup failed: ${e.message}`); }
  mock.close();
}
