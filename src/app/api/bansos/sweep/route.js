import { NextResponse } from "next/server";
import { getProviderNodeById } from "@/models";
import { sweepNode } from "@/lib/bansosSweep.js";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Sweep one bansos pool: probe the credentials that have gone stale and record
 * what each one is now. Keys that answer "invalid / out of quota" are deleted
 * ONLY when that node has auto-purge switched on; every other node just gets
 * its state recorded.
 *
 * POST /api/bansos/sweep  { nodeId, limit?, concurrency?, timeoutMs? }
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { nodeId, limit, concurrency, timeoutMs } = body || {};
    if (!nodeId) return NextResponse.json({ error: "nodeId is required" }, { status: 400 });

    const node = await getProviderNodeById(nodeId);
    if (!node) return NextResponse.json({ error: "Provider node not found" }, { status: 404 });

    const summary = await sweepNode({
      nodeId,
      limit: Number.isFinite(Number(limit)) ? Math.max(1, Math.min(2000, Number(limit))) : undefined,
      concurrency: Number.isFinite(Number(concurrency)) ? Math.max(1, Math.min(32, Number(concurrency))) : undefined,
      timeoutMs: Number.isFinite(Number(timeoutMs)) ? Math.max(1000, Math.min(30000, Number(timeoutMs))) : undefined,
    });
    return NextResponse.json(summary);
  } catch (error) {
    console.log("Error sweeping bansos node:", error);
    return NextResponse.json({ error: error?.message || "Sweep failed" }, { status: 500 });
  }
}
