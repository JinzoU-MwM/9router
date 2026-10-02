import { NextResponse } from "next/server";
import { getProviderNodeById, updateProviderNode } from "@/models";

/**
 * Per-node auto-purge switch.
 *
 * Deliberately separate from PUT /api/provider-nodes/[id]: that route rewrites
 * the node's baseUrl onto every one of its connections, which would flatten a
 * bansos pool (one base URL per key) into a single endpoint. Flipping this
 * switch must not touch credentials at all.
 *
 * GET  /api/provider-nodes/[id]/auto-purge -> { autoPurge }
 * PUT  /api/provider-nodes/[id]/auto-purge { autoPurge: boolean } -> { autoPurge }
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const node = await getProviderNodeById(id);
    if (!node) return NextResponse.json({ error: "Provider node not found" }, { status: 404 });
    return NextResponse.json({ autoPurge: node.autoPurge === true });
  } catch (error) {
    console.log("Error reading auto-purge flag:", error);
    return NextResponse.json({ error: "Failed to read auto-purge flag" }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const raw = body?.autoPurge;
    if (typeof raw !== "boolean") {
      return NextResponse.json({ error: "autoPurge must be a boolean" }, { status: 400 });
    }

    const node = await getProviderNodeById(id);
    if (!node) return NextResponse.json({ error: "Provider node not found" }, { status: 404 });

    const updated = await updateProviderNode(id, { autoPurge: raw });
    return NextResponse.json({ autoPurge: updated?.autoPurge === true });
  } catch (error) {
    console.log("Error updating auto-purge flag:", error);
    return NextResponse.json({ error: "Failed to update auto-purge flag" }, { status: 500 });
  }
}
