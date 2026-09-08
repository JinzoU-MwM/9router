// Custom system prompt injection: per-model system prompts for specific use cases.
// Prompts live in <repo>/prompts/ (shipped with the build; see cli/scripts/build-cli.js
// step 4b) with a runtime override at ~/.9router/prompts/ (DATA_DIR takes priority).
// Same mtime-reload pattern as providers/catalogOverride.js: hot path is one stat.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../../src/lib/dataDir.js";
import { injectSystemPrompt } from "./systemInject.js";

// Prompt files live in <repo>/prompts/ (shipped with the build) or
// ~/.9router/prompts/ (runtime override). Webpack bundles this module, so
// path resolution must probe candidates at runtime, not bake one in.
const here = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE_DIRS = [
  path.join(DATA_DIR, "prompts"),                        // runtime override: ~/.9router/prompts
  path.join(global.__NINEROUTER_APP_DIR || "", "prompts"), // set by custom-server.js = install app dir
  path.join(here, "../../../prompts"),                    // repo source layout (dev)
  path.join(process.cwd(), "prompts"),                    // cwd-based fallback
];
const PROMPTS_DIR = CANDIDATE_DIRS.find((d) => d && fs.existsSync(d)) || CANDIDATE_DIRS[0];

// Map of model name → prompt file under PROMPTS_DIR
const CUSTOM_PROMPTS = {
  "glm-5.3-mod": "glm-5.3-mod.md",
  "glm-5.2-mod": "glm-5.2-mod.md",
  "kimi-k3-mod": "kimi-k3-mod.md",
  "deepseek-v4-mod": "deepseek-v4-mod.md",
  "glm-5.3-flash-mod": "glm-5.3-flash-mod.md",
  "gpt-5.6-luna-mod": "gpt-5.6-luna-mod.md",
  "gpt-5.6-terra-mod": "gpt-5.6-terra-mod.md",
  "gpt-5.6-sol-mod": "gpt-5.6-sol-mod.md",
  "gemini-3.8-flash-mod": "gemini-3.8-flash-mod.md",
};

const cache = new Map(); // file → { mtime, text }

function loadPrompt(file) {
  const p = path.join(PROMPTS_DIR, file);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return null; // missing file → no injection, request passes through
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.text;
  const text = fs.readFileSync(p, "utf8");
  cache.set(file, { mtime: st.mtimeMs, text });
  return text;
}

export function injectCustomPrompt(body, format, model, requestModel) {
  // Combo requests resolve to underlying provider/model before reaching here
  // (e.g. combo "glm-5.3-mod" → "guts/glm-5.3" → model "glm-5.3"), so match on
  // the client-requested model name first, then the resolved model name.
  const file = CUSTOM_PROMPTS[requestModel] || CUSTOM_PROMPTS[model];
  if (!file) return;
  const prompt = loadPrompt(file);
  if (!prompt) return;
  injectSystemPrompt(body, format, prompt);
}
