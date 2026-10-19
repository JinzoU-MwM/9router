"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Toggle } from "@/shared/components";

const LEVER_META = [
  {
    key: "personaIdentityLock",
    env: "PERSONA_IDENTITY_LOCK",
    label: "Identity Lock",
    description:
      "Injects the IDENTITY LOCK + SETUP LOCK system message (anti identity-probe, anti prompt-dump). Keep ON in production.",
  },
  {
    key: "personaTaskDirect",
    env: "PERSONA_TASK_DIRECT",
    label: "Task-Direct Prefix",
    description:
      "Prefixes the live user turn with [TASK-DIRECT] so the model starts on the task instead of a canned persona greeting.",
  },
  {
    key: "personaPrefill",
    env: "PERSONA_PREFILL",
    label: "Few-Shot Priming",
    description:
      "Splices the prefill.json worked example (user asks → RAKYAT answers with the marker) before the live turn. Skipped on tool-declaring requests.",
  },
  {
    key: "personaPrecedence",
    env: "PERSONA_PRECEDENCE",
    label: "Precedence Anchor",
    description:
      "When the client ships its own persona (long system prompt), asserts this gateway persona outranks it.",
  },
  {
    key: "personaTail",
    env: "PERSONA_TAIL",
    label: "Recency Anchor",
    description:
      "Re-states the identity anchor right before the live user turn (strongest attention position).",
  },
];

function fmtBytes(n) {
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtTime(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

export default function PersonaClient() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // editor state
  const [selected, setSelected] = useState(null); // {file, content, dirty}
  const [saving, setSaving] = useState(false);
  const [showEditor, setShowEditor] = useState(false);

  const flash = useCallback((msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(""), 4000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/persona", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!alive) return;
      await load();
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  const openEditor = async (file) => {
    setError("");
    try {
      const res = await fetch(`/api/persona/file?name=${encodeURIComponent(file)}`, {
        cache: "no-store",
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setSelected({ file, content: j.content, disk: j.content, bytes: j.bytes });
      setShowEditor(true);
    } catch (e) {
      setError(e.message);
    }
  };

  const savePrompt = async () => {
    if (!selected) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/persona", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: selected.file,
          content: selected.content,
          overwrite: selected.content !== selected.disk,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      flash(`Saved ${selected.file} (${fmtBytes(j.bytes)}) — hot-reloads on next request`);
      setShowEditor(false);
      setSelected(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 p-4 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Persona Injection</h1>
          <p className="text-sm opacity-70">
            Per-model system prompts (PRESIDENSIAL / RAKYAT JELATA family) — editor, injection
            levers, few-shot prefill. Prompt files hot-reload on mtime; no restart needed.
          </p>
        </div>
        <Button onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </div>

      {error && (
        <div className="rounded border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded border border-green-500/50 bg-green-500/10 px-3 py-2 text-sm text-green-400">
          {notice}
        </div>
      )}

      {/* Levers */}
      <Card className="p-4">
        <h2 className="mb-1 font-medium">Injection Levers</h2>
        <p className="mb-3 text-xs opacity-60">
          Read-only reflection of the runtime environment — injection behaviour is controlled
          exclusively by env vars ({LEVER_META.map((l) => l.env).join(", ")}) set on the gateway
          process. This page does not change runtime behaviour.
        </p>
        <div className="space-y-3">
          {(data?.levers ? LEVER_META : []).map((meta) => {
            const lever = data?.levers?.[meta.key];
            if (!lever) return null;
            return (
              <div
                key={meta.key}
                className="flex items-start justify-between gap-4 rounded border border-white/10 px-3 py-2"
              >
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span
                      className={`rounded px-2 py-0.5 text-[10px] font-mono uppercase ${
                        lever.on ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
                      }`}
                    >
                      {lever.on ? "on" : "off"}
                    </span>
                    {meta.label}
                  </div>
                  <div className="text-xs opacity-60">{meta.description}</div>
                </div>
                <code className="shrink-0 rounded bg-white/5 px-2 py-1 text-[10px] opacity-70">
                  {meta.env}={lever.source === "env" ? "set" : "unset"}
                </code>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Prompt files */}
      <Card className="p-4">
        <h2 className="mb-1 font-medium">Persona Prompts</h2>
        <p className="mb-3 text-xs opacity-60">
          Directory: <code className="opacity-80">{data?.promptsDir || "…"}</code>. One identity
          family, per-model variants. Mapping model → file is fixed in{" "}
          <code className="opacity-80">open-sse/rtk/customPrompt.js</code>.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wide opacity-60">
                <th className="py-2 pr-3">File</th>
                <th className="py-2 pr-3">Models</th>
                <th className="py-2 pr-3">Size</th>
                <th className="py-2 pr-3">Last modified</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {(data?.files || []).map((f) => (
                <tr key={f.file} className="border-b border-white/5">
                  <td className="py-2 pr-3 font-mono text-xs">
                    {f.file}
                    <div className="opacity-50">{f.firstLine}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap gap-1">
                      {f.models.map((m) => (
                        <span
                          key={m}
                          className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px]"
                        >
                          {m}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtBytes(f.bytes)}</td>
                  <td className="py-2 pr-3 whitespace-nowrap text-xs opacity-70">
                    {fmtTime(f.mtimeMs)}
                  </td>
                  <td className="py-2 text-right">
                    <Button onClick={() => openEditor(f.file)}>Edit</Button>
                  </td>
                </tr>
              ))}
              {!loading && !(data?.files || []).length && (
                <tr>
                  <td colSpan={5} className="py-4 text-center opacity-60">
                    No persona prompt files found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Prefill */}
      <Card className="p-4">
        <h2 className="mb-1 font-medium">Few-Shot Prefill</h2>
        <p className="mb-2 text-xs opacity-60">
          <code className="opacity-80">prefill.json</code> in the same directory — a worked
          example spliced before the live turn so the model sees the marker answered, not just
          described. Invalid/missing file silently disables priming.
        </p>
        {data?.prefill && (
          <div className="flex items-center gap-3 text-sm">
            <span
              className={`rounded px-2 py-0.5 text-xs ${
                data.prefill.valid
                  ? "bg-green-500/20 text-green-400"
                  : "bg-red-500/20 text-red-400"
              }`}
            >
              {data.prefill.valid ? "valid" : "missing/invalid"}
            </span>
            <span>{data.prefill.turns} turns</span>
            <span className="opacity-70">{fmtBytes(data.prefill.bytes)}</span>
            <span className="text-xs opacity-60">{fmtTime(data.prefill.mtimeMs)}</span>
          </div>
        )}
      </Card>

      {/* Editor modal */}
      {showEditor && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg border border-white/10 bg-neutral-900 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div>
                <div className="font-medium">{selected.file}</div>
                <div className="text-xs opacity-60">
                  {selected.content.length === selected.disk.length
                    ? `${fmtBytes(selected.content.length)} · unmodified`
                    : `edited — ${fmtBytes(selected.disk.length)} → ${fmtBytes(selected.content.length)}`}
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => setShowEditor(false)}>Cancel</Button>
                <Button
                  onClick={savePrompt}
                  disabled={saving || selected.content === selected.disk}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
            <textarea
              className="flex-1 resize-none bg-neutral-950 p-4 font-mono text-xs leading-relaxed outline-none"
              value={selected.content}
              onChange={(e) =>
                setSelected((s) => ({ ...s, content: e.target.value }))
              }
              spellCheck={false}
              wrap="off"
            />
          </div>
        </div>
      )}
    </div>
  );
}
