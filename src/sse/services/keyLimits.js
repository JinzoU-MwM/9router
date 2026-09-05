// Per-API-key limit checks. Pure helpers plus one in-memory RPM window.
// Limits shape is produced by normalizeLimits() in src/lib/db/repos/apiKeysRepo.js.
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

const WINDOW_MS = 60_000;
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

// ponytail: single-process window that resets on restart; move to the DB or a shared store if several workers ever serve /v1.
const rpmHits = new Map(); // keyId -> number[] hit timestamps (ms)

export function _resetRpmStore() {
  rpmHits.clear();
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** True when `patterns` is empty, `model` is missing, or any `*` glob matches the full model string (case-sensitive). */
export function modelMatches(model, patterns) {
  if (!patterns?.length || !model) return true;
  return patterns.some((p) => globToRegExp(p).test(model));
}

/** Expiry instant in ms, or null. A date-only value (YYYY-MM-DD) expires at the END of that local day. */
export function expiresAtMs(expiresAt) {
  if (!expiresAt) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiresAt);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime();
  const t = Date.parse(expiresAt);
  return Number.isNaN(t) ? null : t;
}

export function checkRpm(keyId, rpm, now = Date.now()) {
  const hits = (rpmHits.get(keyId) || []).filter((t) => now - t < WINDOW_MS);
  rpmHits.set(keyId, hits);
  if (hits.length < rpm) return { allowed: true, retryAfterMs: 0 };
  return { allowed: false, retryAfterMs: WINDOW_MS - (now - hits[0]) };
}

export function recordRpmHit(keyId, now = Date.now()) {
  const hits = rpmHits.get(keyId) || [];
  hits.push(now);
  rpmHits.set(keyId, hits);
}

/** ISO start of the budget period. daily/monthly use local time, matching getLocalDateKey in usageRepo. */
export function periodStart(period, now = Date.now()) {
  const d = new Date(now);
  if (period === "daily") return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  if (period === "monthly") return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
  return EPOCH_ISO;
}

/** ISO end of the budget period, or null for lifetime. */
export function periodEnd(period, now = Date.now()) {
  const d = new Date(now);
  if (period === "daily") return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString();
  if (period === "monthly") return new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString();
  return null;
}

const deny = (status, message, retryAfterMs = null) => ({ status, message, retryAfterMs });

/**
 * Run every limit for a key row, in order: active, expiry, model allowlist, rpm, tpm, budget.
 * Returns null when allowed, else { status, message, retryAfterMs }.
 * `sumTokens(apiKey, sinceIso)` resolves tokens already recorded for that key.
 * ponytail: tpm/budget are measured from usage recorded after responses finish, so one oversized
 * request can cross the line and the next one is the one refused.
 */
export async function checkKeyLimits(keyRow, { model = null, now = Date.now(), sumTokens }) {
  if (!keyRow.isActive) return deny(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  const limits = keyRow.limits;
  if (!limits) return null;

  const expiry = expiresAtMs(limits.expiresAt);
  if (expiry != null && now >= expiry) return deny(HTTP_STATUS.UNAUTHORIZED, "API key expired");

  if (!modelMatches(model, limits.allowedModels)) {
    return deny(HTTP_STATUS.FORBIDDEN, "Model not allowed for this API key");
  }

  if (limits.rpm) {
    const r = checkRpm(keyRow.id, limits.rpm, now);
    if (!r.allowed) return deny(HTTP_STATUS.RATE_LIMITED, "Rate limit exceeded (rpm)", r.retryAfterMs);
  }

  if (limits.tpm) {
    const used = await sumTokens(keyRow.key, new Date(now - WINDOW_MS).toISOString());
    if (used >= limits.tpm) return deny(HTTP_STATUS.RATE_LIMITED, "Rate limit exceeded (tpm)", WINDOW_MS);
  }

  if (limits.tokenBudget) {
    const period = limits.budgetPeriod || "lifetime";
    const used = await sumTokens(keyRow.key, periodStart(period, now));
    if (used >= limits.tokenBudget) {
      const end = periodEnd(period, now);
      return deny(HTTP_STATUS.RATE_LIMITED, "Token budget exhausted", end ? new Date(end).getTime() - now : null);
    }
  }

  if (limits.rpm) recordRpmHit(keyRow.id, now);
  return null;
}
