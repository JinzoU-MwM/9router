/**
 * Bansos auto-purge.
 *
 * A "bansos" node is a pool of free endpoint+key pairs collected from the
 * internet. They die constantly — revoked, out of quota, credit exhausted —
 * and the stock runtime only puts a dead key on a two-minute cooldown
 * (errorConfig.js: 401/402/403/404 -> COOLDOWN.long = 120000ms), so a large
 * pool re-tries corpses on every request.
 *
 * This module deletes the connection outright — but ONLY when the operator has
 * flipped the switch on that specific node. The switch is node-level, never
 * global: the same gateway runs paid nodes where a 401 must never destroy a key.
 *
 * Two rules keep it safe:
 *   - "exhausted" means the credential itself is dead (401/402, or an explicit
 *     quota/credit/billing message). Rate limits and transient failures are NOT
 *     exhaustion — a shared bansos endpoint returns 429 as its normal state, and
 *     deleting on 429 would wipe a healthy pool.
 *   - 403 is only acted on when the body says why. A bare 403 is just as often a
 *     WAF or a geo-block, and that must not evaporate the pool.
 *   - what is deleted is archived first (masked + hashed), so the operator can
 *     still audit what was thrown away.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getProviderNodeById, getProviderConnectionById, deleteProviderConnection } from "@/lib/localDb";
import { DATA_DIR } from "@/lib/dataDir.js";
import * as log from "../utils/logger.js";

const PURGE_STATUS = new Set([401, 402]);

// Explicit "this credential is dead / out of quota" language.
const EXHAUSTED_TEXT = [
  "invalid api key", "invalid_api_key", "incorrect api key", "invalid key",
  "api key not valid", "api key is invalid", "api key is disabled",
  "api_key_disabled", "key has been disabled", "key revoked", "revoked api key",
  "insufficient quota", "quota exceeded", "exceeded your current quota",
  "quota exhausted", "out of quota", "no quota", "insufficient_quota",
  "no credit", "insufficient balance", "insufficient credit",
  "credit balance is too low", "payment required", "billing",
  "account suspended", "account disabled", "account deactivated",
];

// Never destroy a credential for these, whatever the status code says.
const TRANSIENT_TEXT = [
  "rate limit", "rate_limit", "too many requests", "capacity", "overloaded",
  "try again", "temporarily", "timeout", "timed out", "fetch failed",
  "econnrefused", "econnreset", "enotfound", "socket hang up", "bad gateway",
  "gateway timeout",
];

/**
 * Is this failure an exhausted/dead credential (as opposed to a transient one)?
 * Pure — no I/O — so the policy stays unit-testable.
 *
 * @param {number|string} status - upstream HTTP status
 * @param {string} errorText - upstream error body/message
 * @returns {boolean}
 */
export function isPurgeableExhaustion(status, errorText) {
  const code = Number(status);
  if (code === 429) return false;
  const text = String(errorText || "").toLowerCase();
  if (TRANSIENT_TEXT.some((t) => text.includes(t))) return false;
  if (PURGE_STATUS.has(code)) return true;
  return EXHAUSTED_TEXT.some((t) => text.includes(t));
}

/** Short audit fingerprint: never the credential itself. */
export function maskKey(key) {
  const s = String(key || "");
  if (!s) return null;
  const head = s.slice(0, 6);
  const tail = s.length > 10 ? s.slice(-4) : "";
  return `${head}…${tail} (len ${s.length})`;
}

export function hashKey(key) {
  const s = String(key || "");
  if (!s) return null;
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

const ARCHIVE_FILE = path.join(DATA_DIR, "bansos-purged.jsonl");

function archivePurge(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(ARCHIVE_FILE, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    // Archiving is best-effort: never block the purge on a filesystem problem.
    log.warn("BANSOS", `purge archive failed: ${error?.message || error}`);
  }
}

/**
 * Delete a connection when the node it belongs to has auto-purge switched on
 * and the failure means the credential is exhausted.
 *
 * @returns {Promise<{purged: boolean, reason: string, baseUrl?: string|null}>}
 */
export async function purgeExhaustedConnection({ connectionId, provider, status, errorText, model = null }) {
  if (!connectionId || connectionId === "noauth") return { purged: false, reason: "no-connection" };
  if (!isPurgeableExhaustion(status, errorText)) return { purged: false, reason: "not-exhausted" };
  if (!provider) return { purged: false, reason: "no-provider" };

  let node;
  try {
    node = await getProviderNodeById(provider);
  } catch (error) {
    log.warn("BANSOS", `node lookup failed for ${provider}: ${error?.message || error}`);
    return { purged: false, reason: "node-lookup-failed" };
  }
  // Node-level opt-in. Anything else (built-in providers included) is untouched.
  if (!node || node.autoPurge !== true) return { purged: false, reason: "auto-purge-off" };

  const conn = await getProviderConnectionById(connectionId);
  if (!conn) return { purged: false, reason: "already-gone" };

  const baseUrl = conn.providerSpecificData?.baseUrl || node.baseUrl || null;
  const apiKey = conn.apiKey;

  archivePurge({
    at: new Date().toISOString(),
    nodeId: node.id,
    nodeName: node.name || null,
    connectionId,
    name: conn.displayName || conn.name || conn.email || null,
    baseUrl,
    apiKeyMask: maskKey(apiKey),
    apiKeyHash: hashKey(apiKey),
    model,
    status: Number(status) || null,
    reason: String(errorText || "").slice(0, 200) || null,
  });

  await deleteProviderConnection(connectionId);

  log.warn(
    "BANSOS",
    `${node.name || node.id}: removed exhausted key ${maskKey(apiKey)} [${Number(status) || "no-status"}]`
  );
  return { purged: true, reason: "exhausted", baseUrl };
}

export { ARCHIVE_FILE };
