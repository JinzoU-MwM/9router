import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, normalizeLimits, sumApiKeyTokens } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { periodStart } from "@/sse/services/keyLimits.js";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys (+ current-period token usage for keys with a budget)
export async function GET() {
  try {
    const keys = await getApiKeys();
    const withUsage = await Promise.all(keys.map(async (k) => {
      if (!k.limits?.tokenBudget) return k;
      const start = periodStart(k.limits.budgetPeriod || "lifetime");
      try {
        const periodTokens = await sumApiKeyTokens(k.key, start);
        return { ...k, usage: { periodTokens, periodStart: start } };
      } catch (error) {
        // One key's usage query must not take the whole list down.
        console.log("Error summing key usage:", error);
        return { ...k, usage: null };
      }
    }));
    return NextResponse.json({ keys: withUsage });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key (optional per-key limits)
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, limits } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    let normalizedLimits;
    try {
      normalizedLimits = normalizeLimits(limits);
    } catch (e) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId, normalizedLimits);

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
      limits: apiKey.limits,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
