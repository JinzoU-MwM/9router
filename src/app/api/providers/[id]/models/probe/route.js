import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";

const PROBE_TIMEOUT_MS = 20000;

function extractError(status, rawText) {
  let detail = rawText;
  try {
    const parsed = rawText ? JSON.parse(rawText) : null;
    detail = parsed?.error?.message || parsed?.error || parsed?.message || parsed?.msg || rawText;
  } catch {}
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  return `HTTP ${status}${text ? `: ${text.slice(0, 240)}` : ""}`;
}

/**
 * POST /api/providers/[id]/models/probe - Send a 1-token chat request straight to the
 * connection's upstream to check whether a model actually answers. Used by the import
 * picker, so the model does not have to be registered locally first.
 */
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const { model } = await request.json();
    if (!model) return NextResponse.json({ error: "model required" }, { status: 400 });

    const connection = await getProviderConnectionById(id);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    const isAnthropic = isAnthropicCompatibleProvider(connection.provider);
    if (!isAnthropic && !isOpenAICompatibleProvider(connection.provider)) {
      return NextResponse.json({ error: "Probe supports OpenAI/Anthropic compatible providers only" }, { status: 400 });
    }

    let baseUrl = connection.providerSpecificData?.baseUrl;
    if (!baseUrl) return NextResponse.json({ error: "No base URL configured for this provider" }, { status: 400 });
    baseUrl = baseUrl.replace(/\/$/, "");
    if (isAnthropic && baseUrl.endsWith("/messages")) baseUrl = baseUrl.slice(0, -9);

    const url = isAnthropic ? `${baseUrl}/messages` : `${baseUrl}/chat/completions`;
    const headers = isAnthropic
      ? {
        "Content-Type": "application/json",
        "x-api-key": connection.apiKey,
        "anthropic-version": "2023-06-01",
        "Authorization": `Bearer ${connection.apiKey}`,
      }
      : {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${connection.apiKey}`,
      };

    const start = Date.now();
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (error) {
      const latencyMs = Date.now() - start;
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      return NextResponse.json({
        ok: false,
        latencyMs,
        error: timedOut ? `Timeout after ${PROBE_TIMEOUT_MS / 1000}s` : (error?.message || "Network error"),
      });
    }

    const latencyMs = Date.now() - start;
    const rawText = await response.text().catch(() => "");
    if (!response.ok) {
      return NextResponse.json({ ok: false, status: response.status, latencyMs, error: extractError(response.status, rawText) });
    }
    return NextResponse.json({ ok: true, status: response.status, latencyMs, error: null });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
