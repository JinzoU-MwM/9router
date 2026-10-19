import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { CUSTOM_PROMPTS } from "open-sse/rtk/customPrompt.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Same directory resolution as /api/persona — returns the prompt BODY for the
// editor. GET only; writes go through PUT /api/persona (which validates the
// mapping and the persona marker).
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

export async function GET(request) {
  try {
    const name = new URL(request.url).searchParams.get("name") || "";
    const safeName = path.basename(name); // no traversal (CWE-22)
    if (!Object.values(CUSTOM_PROMPTS).includes(safeName)) {
      return NextResponse.json(
        { error: `file is not a mapped persona prompt: ${safeName}` },
        { status: 400 }
      );
    }
    const dir = resolvePromptsDir();
    const target = path.join(dir, safeName);
    const content = fs.readFileSync(target, "utf8");
    return NextResponse.json(
      { file: safeName, content, bytes: Buffer.byteLength(content, "utf8") },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: error.code === "ENOENT" ? 404 : 500 });
  }
}
