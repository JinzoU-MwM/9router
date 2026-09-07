"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";
import { isFreeModel } from "@/shared/utils/freeModel";

// Upstreams rate-limit aggressively on free tiers; 5 in flight keeps the sweep
// quick without tripping 429s that would show as false reds.
const PROBE_CONCURRENCY = 5;

function statusIcon(result) {
  if (!result) return { icon: "radio_button_unchecked", color: undefined };
  return result.ok
    ? { icon: "check_circle", color: "#22c55e" }
    : { icon: "cancel", color: "#ef4444" };
}

function PriceBadge({ free }) {
  if (free === true) return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-green-500/15 text-green-600">FREE</span>;
  if (free === false) return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sidebar text-text-muted">PAID</span>;
  return <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sidebar text-text-muted" title="Provider sent no pricing info">?</span>;
}

PriceBadge.propTypes = { free: PropTypes.bool };

export default function ImportModelsModal({ isOpen, onClose, connectionId, existingIds, onImport }) {
  // Mounted only while open (see CompatibleModelsSection), so initial state doubles
  // as the per-open reset — no state clearing inside the fetch effect.
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [models, setModels] = useState([]);
  const [query, setQuery] = useState("");
  const [freeOnly, setFreeOnly] = useState(true);
  const [checked, setChecked] = useState(() => new Set());
  const [results, setResults] = useState({});
  const [progress, setProgress] = useState(null);
  const [importing, setImporting] = useState(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!connectionId) return;
    let aborted = false;

    fetch(`/api/providers/${connectionId}/models`)
      .then(async (res) => {
        const data = await res.json();
        if (aborted) return;
        if (!res.ok) {
          setLoadError(data.error || `Failed to fetch models (${res.status})`);
          return;
        }
        const seen = new Set();
        const rows = [];
        for (const model of data.models || []) {
          const id = model?.id || model?.name || model?.model;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          rows.push({ id, free: isFreeModel(model) });
        }
        rows.sort((a, b) => a.id.localeCompare(b.id));
        setModels(rows);
      })
      .catch((error) => { if (!aborted) setLoadError(error.message || "Failed to fetch models"); })
      .finally(() => { if (!aborted) setLoading(false); });

    return () => { aborted = true; };
  }, [connectionId]);

  // Stop any running sweep when the modal unmounts.
  useEffect(() => () => { cancelRef.current = true; }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return models.filter((model) => {
      if (freeOnly && model.free !== true) return false;
      if (needle && !model.id.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [models, query, freeOnly]);

  const testable = useMemo(
    () => visible.filter((model) => !existingIds.has(model.id)).map((model) => model.id),
    [visible, existingIds]
  );

  const runTests = useCallback(async (ids) => {
    if (!ids.length || progress) return;
    cancelRef.current = false;
    setProgress({ done: 0, total: ids.length });

    let cursor = 0;
    let done = 0;
    const worker = async () => {
      while (!cancelRef.current) {
        const index = cursor;
        cursor += 1;
        if (index >= ids.length) break;
        const model = ids[index];
        let result;
        try {
          const res = await fetch(`/api/providers/${connectionId}/models/probe`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model }),
          });
          const data = await res.json();
          result = { ok: data.ok === true, error: data.error || null, latencyMs: data.latencyMs };
        } catch (error) {
          result = { ok: false, error: error.message || "Request failed" };
        }
        setResults((prev) => ({ ...prev, [model]: result }));
        done += 1;
        setProgress({ done, total: ids.length });
      }
    };

    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, ids.length) }, worker));
    setProgress(null);
  }, [connectionId, progress]);

  const toggle = (id) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectGreen = () => {
    setChecked(new Set(models.filter((model) => results[model.id]?.ok && !existingIds.has(model.id)).map((model) => model.id)));
  };

  const handleImport = async () => {
    const ids = [...checked].filter((id) => !existingIds.has(id));
    if (!ids.length) return;
    setImporting({ done: 0, total: ids.length });
    try {
      for (let i = 0; i < ids.length; i += 1) {
        await onImport(ids[i]);
        setImporting({ done: i + 1, total: ids.length });
      }
      onClose();
    } finally {
      setImporting(null);
    }
  };

  const freeCount = models.filter((model) => model.free === true).length;
  const selectedCount = [...checked].filter((id) => !existingIds.has(id)).length;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Import models from /models"
      size="full"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={!!importing}>Cancel</Button>
          <Button icon="download" onClick={handleImport} disabled={!selectedCount || !!importing}>
            {importing ? `Importing ${importing.done}/${importing.total}...` : `Import selected (${selectedCount})`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search model ID"
            className="flex-1 min-w-[200px] px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
          />
          <label className="flex items-center gap-1.5 text-sm text-text-muted cursor-pointer select-none">
            <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} />
            Free only
          </label>
          <Button size="sm" variant="secondary" icon="science" onClick={() => runTests(testable)} disabled={!testable.length || !!progress}>
            {progress ? `Testing ${progress.done}/${progress.total}` : `Test shown (${testable.length})`}
          </Button>
          {progress && (
            <Button size="sm" variant="ghost" onClick={() => { cancelRef.current = true; }}>Stop</Button>
          )}
          <Button size="sm" variant="secondary" icon="done_all" onClick={selectGreen} disabled={!Object.values(results).some((r) => r.ok)}>
            Select green
          </Button>
        </div>

        <p className="text-xs text-text-muted">
          {loading ? "Fetching..." : `${models.length} fetched · ${freeCount} free · ${visible.length} shown`}
        </p>

        {loadError && <p className="text-sm text-red-500">{loadError}</p>}

        <div className="flex flex-col gap-1 max-h-[45vh] overflow-y-auto custom-scrollbar">
          {visible.map((model) => {
            const added = existingIds.has(model.id);
            const result = results[model.id];
            const { icon, color } = statusIcon(result);
            return (
              <label
                key={model.id}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg border border-border ${added ? "opacity-50" : "hover:bg-sidebar/50 cursor-pointer"}`}
              >
                <input
                  type="checkbox"
                  disabled={added}
                  checked={added || checked.has(model.id)}
                  onChange={() => toggle(model.id)}
                />
                <span className="material-symbols-outlined text-base text-text-muted" style={color ? { color } : undefined}>{icon}</span>
                <span className="flex-1 min-w-0 text-sm font-mono truncate" title={model.id}>{model.id}</span>
                <PriceBadge free={model.free} />
                <span className="text-xs text-text-muted w-48 text-right truncate" title={result?.error || ""}>
                  {added ? "already added" : result ? (result.ok ? `ok ${result.latencyMs}ms` : result.error) : ""}
                </span>
              </label>
            );
          })}
          {!loading && !loadError && visible.length === 0 && (
            <p className="text-sm text-text-muted py-4 text-center">
              {freeOnly && models.length > 0 ? "No free models detected — uncheck \"Free only\" to see the rest." : "No models returned from /models."}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

ImportModelsModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  connectionId: PropTypes.string,
  existingIds: PropTypes.instanceOf(Set).isRequired,
  onImport: PropTypes.func.isRequired,
};
