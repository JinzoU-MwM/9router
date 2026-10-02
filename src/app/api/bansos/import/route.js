import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getProviderNodeById, getProviderConnections, createProviderConnection } from "@/models";
import { parseBansosText } from "@/lib/bansosImport.js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_ENTRIES = 5000;

const dedupeKey = (baseUrl, apiKey) =>
  crypto.createHash("sha256").update(`${baseUrl}\n${apiKey}`).digest("hex");

/**
 * Bulk import for a bansos pool: one paste -> many connections under ONE node.
 *
 * Base URL lives per connection (providerSpecificData.baseUrl), which is what
 * lets a single node hold hundreds of different relays — so the dashboard stays
 * one node, not hundreds.
 *
 * POST /api/bansos/import
 *   { nodeId, text }                       paste block (line formats handled by
 *                                          src/lib/bansosImport.js)
 *   { nodeId, entries: [{baseUrl, apiKey}] }  already-structured input
 * -> { imported, duplicate, invalid, invalidSample, nodeId }
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { nodeId, text, entries: rawEntries } = body || {};

    if (!nodeId) return NextResponse.json({ error: "nodeId is required" }, { status: 400 });
    const node = await getProviderNodeById(nodeId);
    if (!node) return NextResponse.json({ error: "Provider node not found" }, { status: 404 });

    let entries = [];
    let invalid = [];
    if (Array.isArray(rawEntries)) {
      for (const e of rawEntries) {
        if (!e?.baseUrl || !e?.apiKey) {
          invalid.push({ line: invalid.length + 1, text: JSON.stringify(e).slice(0, 120), reason: "baseUrl and apiKey are required" });
          continue;
        }
        entries.push({ baseUrl: String(e.baseUrl), apiKey: String(e.apiKey).trim(), line: entries.length + 1 });
      }
    } else {
      ({ entries, invalid } = parseBansosText(text));
    }

    if (!entries.length) {
      return NextResponse.json({ imported: 0, duplicate: 0, invalid: invalid.length, invalidSample: invalid.slice(0, 20), nodeId });
    }
    if (entries.length > MAX_ENTRIES) {
      return NextResponse.json({ error: `Too many entries (${entries.length}); limit is ${MAX_ENTRIES} per request` }, { status: 413 });
    }

    const existing = await getProviderConnections({ provider: nodeId });
    const seen = new Set(existing.map((c) => dedupeKey(c.providerSpecificData?.baseUrl || c.baseUrl || "", c.apiKey || "")));

    const prefix = node.prefix || "bansos";
    let imported = 0;
    let duplicate = 0;

    for (const entry of entries) {
      const key = dedupeKey(entry.baseUrl, entry.apiKey);
      if (seen.has(key)) { duplicate++; continue; }
      seen.add(key);
      try {
        await createProviderConnection({
          provider: nodeId,
          authType: "apikey",
          name: `bansos-${key.slice(0, 10)}`,
          isActive: true,
          apiKey: entry.apiKey,
          providerSpecificData: { baseUrl: entry.baseUrl, prefix, apiType: node.apiType || "chat", nodeName: node.name },
        });
        imported++;
      } catch (error) {
        invalid.push({ line: entry.line, text: entry.baseUrl, reason: error?.message?.slice(0, 160) || "insert failed" });
      }
    }

    return NextResponse.json({
      imported,
      duplicate,
      invalid: invalid.length,
      invalidSample: invalid.slice(0, 20),
      total: existing.length + imported,
      nodeId,
    });
  } catch (error) {
    console.log("Error importing bansos block:", error);
    return NextResponse.json({ error: "Import failed" }, { status: 500 });
  }
}
