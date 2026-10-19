import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { CUSTOM_PROMPTS, loadCustomPersonas } from "open-sse/rtk/customPrompt.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Same directory resolution as open-sse/rtk/customPrompt.js — the API edits the
// files that module actually loads (runtime override wins, repo source is the
// fallback used on dev machines).
function resolvePromptsDir() {
  const candidates = [
    process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "prompts") : null,
    path.join(global.__NINEROUTER_APP_DIR || "", "prompts"),
    path.join(process.cwd(), "prompts"),
  ].filter(Boolean);
  for (const d of candidates) {
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch {}
  }
  return candidates[candidates.length - 1];
}

const PERSONA_SETTING_KEYS = [
  "personaIdentityLock",
  "personaTaskDirect",
  "personaPrecedence",
  "personaTail",
  "personaPrefill",
];

const ENV_TO_SETTING = {
  personaIdentityLock: "PERSONA_IDENTITY_LOCK",
  personaTaskDirect: "PERSONA_TASK_DIRECT",
  personaPrecedence: "PERSONA_PRECEDENCE",
  personaTail: "PERSONA_TAIL",
  personaPrefill: "PERSONA_PREFILL",
};

function isOn(value) {
  if (value === undefined || value === null || value === "") return true;
  return !["off", "0", "false", "no"].includes(String(value).toLowerCase());
}

// All persona mappings: built-in + dashboard-added (custom-personas.json).
function allMappings(dir) {
  const merged = { ...CUSTOM_PROMPTS };
  try {
    const custom = loadCustomPersonas();
    for (const [k, v] of Object.entries(custom)) {
      // verify the referenced file actually exists in dir (otherwise the
      // loader would later no-op on it anyway)
      try {
        fs.statSync(path.join(dir, v));
        merged[k] = v;
      } catch {}
    }
  } catch {}
  return merged;
}

export async function GET() {
  try {
    const dir = resolvePromptsDir();
    const files = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const st = fs.statSync(path.join(dir, f));
      const models = Object.entries(allMappings(dir))
        .filter(([, file]) => file === f)
        .map(([model]) => model);
      // Preview: strip markdown for a compact first-line summary
      let firstLine = "";
      try {
        firstLine =
          fs
            .readFileSync(path.join(dir, f), "utf8")
            .split("\n")
            .find((l) => l.trim() && !l.startsWith("<!--")) || "";
      } catch {}
      files.push({
        file: f,
        bytes: st.size,
        mtimeMs: Math.round(st.mtimeMs),
        models,
        custom: Object.values(loadCustomPersonas()).includes(f),
        firstLine: firstLine.slice(0, 160),
      });
    }
    files.sort((a, b) => a.file.localeCompare(b.file));

    let prefill = null;
    try {
      const p = path.join(dir, "prefill.json");
      const st = fs.statSync(p);
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const turns = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.turns)
          ? raw.turns
          : [];
      prefill = {
        turns: turns.length,
        valid: turns.length >= 2,
        bytes: st.size,
        mtimeMs: Math.round(st.mtimeMs),
      };
    } catch {
      prefill = { turns: 0, valid: false, bytes: 0, mtimeMs: 0 };
    }

    const levers = {};
    for (const key of PERSONA_SETTING_KEYS) {
      const envVal = process.env[ENV_TO_SETTING[key]];
      // Read-only reflection of the runtime env — the dashboard does not change
      // injection behaviour; env vars remain the single source of control.
      levers[key] = {
        on: envVal === undefined ? true : isOn(envVal),
        source: envVal !== undefined && envVal !== "" ? "env" : "default",
      };
    }

    return NextResponse.json(
      { promptsDir: dir, files, prefill, levers },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = await request.json();
    const dir = resolvePromptsDir();

    // 1. Save prompt body (must contain the persona marker to prevent editing
    //    an unrelated file into a non-persona prompt by accident).
    if (typeof body.file === "string" && typeof body.content === "string") {
      const safeName = path.basename(body.file); // no traversal (CWE-22)
      const mappings = allMappings(dir);
      if (!Object.values(mappings).includes(safeName)) {
        return NextResponse.json(
          { error: `file is not a mapped persona prompt: ${safeName}` },
          { status: 400 }
        );
      }
      const target = path.join(dir, safeName);
      const existing = fs.existsSync(target)
        ? fs.readFileSync(target, "utf8")
        : "";
      if (existing && !body.overwrite) {
        return NextResponse.json(
          { error: "file changed on disk — pass overwrite:true to force" },
          { status: 409 }
        );
      }
      if (!existing && !body.content.includes("RAKYAT")) {
        return NextResponse.json(
          { error: "refusing to write a prompt without the persona marker" },
          { status: 400 }
        );
      }
      fs.writeFileSync(target, body.content, "utf8");
      return NextResponse.json({ ok: true, file: safeName, bytes: body.content.length });
    }

    // 1b. Add a new persona mapping: { addPersona: { model, content? , copyFrom? } }
    //     Creates prompts/<model>.md (or copies a template) and refs it from
    //     custom-personas.json. Injection picks it up on the next request —
    //     loadCustomPersonas is mtime-cached, no restart.
    if (body.addPersona && typeof body.addPersona === "object") {
      const model = String(body.addPersona.model || "").trim();
      // model id sanity: no whitespace, no path chars, non-empty
      if (
        !model ||
        /\s/.test(model) ||
        model !== path.basename(model) ||
        model.includes("/") || model.includes("\\") || model.includes("..")
      ) {
        return NextResponse.json({ error: `invalid model id: ${model}` }, { status: 400 });
      }
      const fileName = `${model}.md`;
      const mappings = allMappings(dir);
      if (Object.values(mappings).includes(fileName) || mappings[model]) {
        return NextResponse.json(
          { error: `persona already exists for model: ${model}` },
          { status: 409 }
        );
      }
      const target = path.join(dir, fileName);
      let content = typeof body.addPersona.content === "string" ? body.addPersona.content : "";
      if (!content && typeof body.addPersona.copyFrom === "string") {
        const srcName = path.basename(body.addPersona.copyFrom);
        const mappingsVals = Object.values(mappings);
        if (!mappingsVals.includes(srcName)) {
          return NextResponse.json({ error: `copyFrom is not a mapped prompt: ${srcName}` }, { status: 400 });
        }
        content = fs.readFileSync(path.join(dir, srcName), "utf8");
      }
      if (!content) {
        return NextResponse.json(
          { error: "addPersona needs content or copyFrom" },
          { status: 400 }
        );
      }
      if (!content.includes("RAKYAT")) {
        return NextResponse.json(
          { error: "persona content must contain the RAKYAT marker" },
          { status: 400 }
        );
      }
      fs.writeFileSync(target, content, "utf8");
      // append mapping to custom-personas.json
      const cpPath = path.join(dir, "custom-personas.json");
      let map = {};
      try {
        const prev = JSON.parse(fs.readFileSync(cpPath, "utf8"));
        if (prev && typeof prev === "object" && !Array.isArray(prev)) map = prev;
      } catch {}
      map[model] = fileName;
      fs.writeFileSync(cpPath, JSON.stringify(map, null, 2), "utf8");
      return NextResponse.json({ ok: true, model, file: fileName, bytes: content.length });
    }

    // 1c. Remove a dashboard-added persona mapping: { removePersona: model }
    if (typeof body.removePersona === "string") {
      const model = body.removePersona.trim();
      const customPath = path.join(dir, "custom-personas.json");
      let map = {};
      let hadFile = false;
      try {
        const prev = JSON.parse(fs.readFileSync(customPath, "utf8"));
        if (prev && typeof prev === "object" && !Array.isArray(prev)) map = prev;
        hadFile = true;
      } catch {}
      if (!map[model]) {
        return NextResponse.json(
          { error: `not a dashboard-added persona: ${model} (built-in mappings cannot be removed here)` },
          { status: 400 }
        );
      }
      const fileName = map[model];
      delete map[model];
      if (hadFile) fs.writeFileSync(customPath, JSON.stringify(map, null, 2), "utf8");
      else fs.writeFileSync(customPath, JSON.stringify(map, null, 2), "utf8");
      // leave the .md file on disk — deletion of content is a separate,
      // explicit action (the editor's save flow handles content)
      return NextResponse.json({ ok: true, removed: model, fileKept: fileName });
    }

    // 2. Save prefill.json
    if (Array.isArray(body.prefillTurns)) {
      const clean = body.prefillTurns
        .filter(
          (t) =>
            t &&
            (t.role === "user" || t.role === "assistant") &&
            typeof t.content === "string" &&
            t.content.trim()
        )
        .map((t) => ({ role: t.role, content: t.content }));
      if (clean.length && clean.length < 2) {
        return NextResponse.json(
          { error: "prefill needs ≥2 turns (user + assistant pair)" },
          { status: 400 }
        );
      }
      const target = path.join(dir, "prefill.json");
      if (clean.length === 0 && fs.existsSync(target) && !body.overwrite) {
        return NextResponse.json(
          { error: "pass overwrite:true to delete prefill" },
          { status: 409 }
        );
      }
      if (clean.length === 0) {
        fs.rmSync(target, { force: true });
        return NextResponse.json({ ok: true, prefill: "removed" });
      }
      fs.writeFileSync(
        target,
        JSON.stringify({ turns: clean }, null, 2),
        "utf8"
      );
      return NextResponse.json({ ok: true, prefill: { turns: clean.length } });
    }

    // 3. Lever toggles are NOT writable — env vars are the single runtime
    //    control (open-sse/rtk/customPrompt.js reads them directly). The
    //    dashboard reflects them read-only.

    return NextResponse.json({ error: "nothing to do" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
