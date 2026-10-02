"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Badge, Button, Modal } from "@/shared/components";

/**
 * Bansos pool tools: paste-import a whole block of relay keys, and sweep the
 * pool to find out which of them are still alive.
 *
 * Deliberately separate from the connection UI: a pool here is hundreds of rows
 * of text from the internet, and the two actions that matter are "take this
 * block" and "tell me what still works".
 */
export default function BansosToolsModal({ isOpen, node, connections, onRefresh, onClose }) {
  const [text, setText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepResult, setSweepResult] = useState(null);
  const [sweepError, setSweepError] = useState(null);

  const pool = useMemo(() => {
    const counts = { total: connections?.length || 0, live: 0, cooldown: 0, exhausted: 0, unchecked: 0 };
    for (const c of connections || []) {
      const state = c.bansosState?.state;
      if (state === "live") counts.live++;
      else if (state === "cooldown") counts.cooldown++;
      else if (state === "exhausted") counts.exhausted++;
      else counts.unchecked++;
    }
    return counts;
  }, [connections]);

  const handleImport = async () => {
    if (!text.trim() || importing) return;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const res = await fetch("/api/bansos/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: node.id, text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setImportResult(data);
      if (data.imported > 0) {
        setText("");
        await onRefresh?.();
      }
    } catch (error) {
      setImportError(error.message || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const handleSweep = async () => {
    if (sweeping) return;
    setSweeping(true);
    setSweepError(null);
    setSweepResult(null);
    try {
      const res = await fetch("/api/bansos/sweep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId: node.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setSweepResult(data);
      await onRefresh?.();
    } catch (error) {
      setSweepError(error.message || "Sweep failed");
    } finally {
      setSweeping(false);
    }
  };

  if (!node) return null;

  return (
    <Modal isOpen={isOpen} title="Bansos pool tools" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge>{pool.total} keys</Badge>
          {pool.live > 0 && <Badge variant="success">{pool.live} live</Badge>}
          {pool.cooldown > 0 && <Badge>{pool.cooldown} cooldown</Badge>}
          {pool.exhausted > 0 && <Badge variant="error">{pool.exhausted} exhausted</Badge>}
          {pool.unchecked > 0 && <span className="opacity-60">{pool.unchecked} never probed</span>}
        </div>

        <div className="flex flex-col gap-2 border-t pt-3">
          <p className="text-sm font-medium">Import a block</p>
          <p className="text-xs opacity-60">
            One key per line. Accepted: <code>url|key</code>, <code>url&lt;tab&gt;key</code>, <code>url,key</code>,
            {" "}<code>key@host</code>, bare host, or one JSON object per line. Comments and blank lines are skipped;
            duplicates are ignored. Every line lands in THIS node — the base URL is stored per key, so a pool stays one node.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={8}
            spellCheck={false}
            placeholder={"https://relay-a.example/v1|sk-xxxxxxxxxxxxxxxx\nhttps://relay-b.example/v1|sk-yyyyyyyyyyyyyyyy"}
            className="w-full rounded-[10px] border border-black/[0.06] bg-transparent p-3 font-mono text-xs dark:border-white/[0.08]"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleImport} disabled={!text.trim() || importing}>
              {importing ? "Importing..." : "Import"}
            </Button>
            {text.trim() && (
              <span className="text-xs opacity-60">{text.trim().split(/\r?\n/).filter((l) => l.trim()).length} lines</span>
            )}
          </div>
          {importError && <Badge variant="error">{importError}</Badge>}
          {importResult && (
            <div className="flex flex-col gap-1 text-xs">
              <span>
                imported <strong>{importResult.imported}</strong> · duplicate {importResult.duplicate} · invalid {importResult.invalid}
                {typeof importResult.total === "number" ? ` · pool now ${importResult.total}` : ""}
              </span>
              {importResult.invalidSample?.length > 0 && (
                <details>
                  <summary className="cursor-pointer opacity-60">show rejected lines</summary>
                  <ul className="mt-1 flex flex-col gap-1">
                    {importResult.invalidSample.map((bad, i) => (
                      <li key={i} className="font-mono text-[11px] opacity-70">
                        line {bad.line}: {bad.reason} — {String(bad.text).slice(0, 60)}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t pt-3">
          <p className="text-sm font-medium">Sweep now</p>
          <p className="text-xs opacity-60">
            Probes keys that have gone stale (cheap <code>/models</code> call first) and records live / cooldown / exhausted
            for each one. Keys that answer invalid or out of quota are removed <strong>only</strong> when
            &ldquo;Auto-delete exhausted keys&rdquo; is on for this node. Rate limits and timeouts are never deleted.
          </p>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={handleSweep} disabled={sweeping}>
              {sweeping ? "Sweeping..." : "Sweep now"}
            </Button>
            {node.autoPurge === true
              ? <Badge variant="error">auto-purge ON</Badge>
              : <Badge>auto-purge off — state only</Badge>}
          </div>
          {sweepError && <Badge variant="error">{sweepError}</Badge>}
          {sweepResult && (
            <span className="text-xs">
              probed <strong>{sweepResult.probed}</strong>/{sweepResult.pool} · live {sweepResult.live} ·
              cooldown {sweepResult.cooldown} · exhausted {sweepResult.exhausted} ·
              deleted <strong>{sweepResult.deleted}</strong> · skipped {sweepResult.skipped}
            </span>
          )}
        </div>
      </div>
    </Modal>
  );
}

BansosToolsModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  node: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    autoPurge: PropTypes.bool,
  }),
  connections: PropTypes.array,
  onRefresh: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
