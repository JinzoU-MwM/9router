#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// sync-persona-prompts.mjs
//
// Syncs the repo's generated persona prompts into every runtime location that
// customPrompt.js probes, so the persona a running 9router picks up always
// matches the committed source of truth.
//
// customPrompt.js resolves PROMPTS_DIR by first match among (see its
// CANDIDATE_DIRS):
//    1. $DATA_DIR/prompts            → runtime override (~/.9router/prompts)
//    2. $__NINEROUTER_APP_DIR/prompts → standalone app dir
//    3. <repo>/prompts                → repo source layout
//    4. $PWD/prompts                  → cwd fallback
//
// The loader caches on mtime, so a sync is picked up on the NEXT request with
// no gateway restart ("hot reload").
//
// Usage:
//   node scripts/sync-persona-prompts.mjs            # repo prompts/ + $DATA_DIR/prompts
//   node scripts/sync-persona-prompts.mjs --dry-run
//   DATA_DIR=~/.9router node scripts/sync-persona-prompts.mjs
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const SRC = path.join(repoRoot, "prompts");

const DRY = process.argv.includes("--dry-run");

function dataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "9router");
  }
  return path.join(os.homedir(), ".9router");
}

if (!fs.existsSync(SRC)) {
  console.error(`[persona-sync] source prompts dir missing: ${SRC}`);
  console.error(`[persona-sync] run: node scripts/build-presidensial-prompts.mjs`);
  process.exit(1);
}

const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".md"));
if (!files.length) {
  console.error(`[persona-sync] no prompt files in ${SRC}`);
  process.exit(1);
}

const DEST_DIRS = [path.join(dataDir(), "prompts")];

let copied = 0;
let unchanged = 0;
for (const dir of DEST_DIRS) {
  if (!DRY) fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const src = path.join(SRC, f);
    const dst = path.join(dir, f);
    const srcBuf = fs.readFileSync(src);
    let same = false;
    try {
      same = fs.readFileSync(dst).equals(srcBuf);
    } catch { /* dst absent */ }
    if (same) { unchanged++; continue; }
    if (DRY) {
      console.log(`[persona-sync] (dry) would write ${dst}`);
    } else {
      fs.writeFileSync(dst, srcBuf);
    }
    copied++;
  }
}

console.log(`[persona-sync] source: ${SRC}  (${files.length} files)`);
for (const d of DEST_DIRS) console.log(`[persona-sync] target: ${d}`);
console.log(`[persona-sync] ${DRY ? "(dry-run) " : ""}copied=${copied} unchanged=${unchanged}`);
console.log(`[persona-sync] hot-reload: customPrompt.js caches on mtime — next request picks this up, no restart`);
