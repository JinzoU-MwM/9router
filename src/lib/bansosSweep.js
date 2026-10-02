/**
 * Bansos pool sweeper.
 *
 * The runtime cooldown (errorConfig.js) only ever parks a dead key for two
 * minutes; it never retires it. A pool of hundreds of shared keys therefore
 * keeps dialling corpses. The reactive path in auth.js handles the keys that
 * are actually hit; this sweep handles the rest — it probes the ones that have
 * gone stale and records what each key is now, so the pool has a live/dead map
 * instead of a hopeful list.
 *
 * Two lines never blur:
 *   - only a node the operator switched on (autoPurge) gets keys DELETED; every
 *     other node merely gets its state recorded.
 *   - 429/5xx/network are not death. A shared free relay answers 429 as its
 *     normal state; deleting on that would wipe a healthy pool.
 */
import { getProviderNodeById, getProviderConnections, updateProviderConnection, deleteProviderConnections } from "@/lib/localDb";
import { isPurgeableExhaustion, maskKey, hashKey, archivePurgeEntry } from "@/sse/services/bansosPurge.js";
import { probeConnection } from "@/lib/bansosProbe.js";
import * as log from "@/sse/utils/logger.js";

const LIVE_RECHECK_MS = 60 * 60 * 1000;
const COOLDOWN_RECHECK_MS = 15 * 60 * 1000;
const DEAD_RECHECK_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 200;
const DEFAULT_CONCURRENCY = 8;

/** Pure: what does one probe result mean for this key? */
export function classifyProbe({ ok, status, errorText }) {
  if (ok) return "live";
  if (isPurgeableExhaustion(status, errorText)) return "exhausted";
  return "cooldown";
}

/** Pure: is this key due for a re-probe? */
export function shouldProbe(connection, now = Date.now()) {
  const s = connection?.bansosState;
  if (!s?.lastCheckedAt) return true;
  const recheckAt = s.recheckAt ? new Date(s.recheckAt).getTime() : 0;
  if (recheckAt && recheckAt > now) return false;
  const age = now - new Date(s.lastCheckedAt).getTime();
  if (s.state === "live") return age > LIVE_RECHECK_MS;
  if (s.state === "cooldown") return age > COOLDOWN_RECHECK_MS;
  return age > DEAD_RECHECK_MS;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Probe the stale credentials of one node and record what each one is now.
 * Deletes only when the node has auto-purge on and the key is exhausted.
 *
 * @param {{nodeId: string, limit?: number, concurrency?: number, timeoutMs?: number, now?: number}} opts
 */
export async function sweepNode({ nodeId, limit = DEFAULT_LIMIT, concurrency = DEFAULT_CONCURRENCY, timeoutMs, now = Date.now() }) {
  const node = await getProviderNodeById(nodeId);
  if (!node) throw new Error("Provider node not found");

  const all = await getProviderConnections({ provider: nodeId, isActive: true });
  const due = all.filter((c) => shouldProbe(c, now)).slice(0, limit);

  const results = await mapLimit(due, concurrency, async (conn) => {
    const baseUrl = conn.providerSpecificData?.baseUrl || node.baseUrl || null;
    const probe = await probeConnection({ baseUrl, apiKey: conn.apiKey, model: conn.defaultModel, timeoutMs });
    return { conn, baseUrl, probe, verdict: classifyProbe(probe) };
  });

  const autoPurge = node.autoPurge === true;
  const toDelete = [];
  const counts = { live: 0, cooldown: 0, exhausted: 0, deleted: 0, unreachable: 0 };

  for (const r of results) {
    const { conn, baseUrl, probe, verdict } = r;
    const at = new Date(now).toISOString();
    const prev = conn.bansosState || {};
    const okCount = verdict === "live" ? (prev.okCount || 0) + 1 : prev.okCount || 0;
    const failCount = verdict === "live" ? 0 : (prev.failCount || 0) + 1;

    if (verdict === "live") counts.live++;
    else if (verdict === "cooldown") counts.cooldown++;
    else counts.exhausted++;
    if (probe.status === 0) counts.unreachable++;

    if (verdict === "exhausted" && autoPurge) {
      archivePurgeEntry({
        at,
        nodeId: node.id,
        nodeName: node.name || null,
        connectionId: conn.id,
        name: conn.displayName || conn.name || null,
        baseUrl,
        apiKeyMask: maskKey(conn.apiKey),
        apiKeyHash: hashKey(conn.apiKey),
        model: conn.defaultModel || null,
        status: probe.status,
        reason: String(probe.errorText || "").slice(0, 200) || null,
        source: "sweep",
      });
      toDelete.push(conn.id);
      counts.deleted++;
      continue;
    }

    const recheckAt =
      verdict === "live" ? now + LIVE_RECHECK_MS
        : verdict === "cooldown" ? now + COOLDOWN_RECHECK_MS
          : now + DEAD_RECHECK_MS * Math.min(4, Math.max(1, Math.ceil(failCount / 3)));

    await updateProviderConnection(conn.id, {
      bansosState: {
        state: verdict,
        lastStatus: probe.status,
        lastCheckedAt: at,
        reason: String(probe.errorText || "").slice(0, 200) || null,
        okCount,
        failCount,
        recheckAt: new Date(recheckAt).toISOString(),
      },
    });
  }

  // One bulk delete: the single-id path reorders the whole pool per row (9.35
  // ms/key measured on a 2000 pool).
  if (toDelete.length) await deleteProviderConnections(toDelete);

  const summary = {
    nodeId,
    nodeName: node.name || null,
    autoPurge,
    pool: all.length,
    probed: results.length,
    skipped: all.length - results.length,
    ...counts,
  };
  log.info("BANSOS", `sweep ${node.name || nodeId}: probed ${summary.probed}/${summary.pool}, live ${counts.live}, cooldown ${counts.cooldown}, exhausted ${counts.exhausted}, deleted ${counts.deleted}`);
  return summary;
}

export { LIVE_RECHECK_MS, COOLDOWN_RECHECK_MS, DEAD_RECHECK_MS };
