import { PROVIDER_MODELS } from "@/shared/constants/models";
import { buildModelsList, INTERNAL_MODELS_FETCH_HEADER } from "../../v1/models/route.js";
import { filterModelsForApiKey } from "@/sse/services/auth";

// Gemini's list carries no kind field, so expose every real model kind. The
// webSearch/webFetch pseudo-models are not generateContent targets and stay out.
const GEMINI_LISTED_KINDS = ["llm", "image", "tts", "stt", "embedding", "imageToText"];

const DEFAULT_INPUT_TOKEN_LIMIT = 128000;
const DEFAULT_OUTPUT_TOKEN_LIMIT = 8192;

// `alias/id` -> display name from the static catalog, for the entries that carry one.
const STATIC_MODEL_NAMES = new Map(
  Object.entries(PROVIDER_MODELS).flatMap(([alias, models]) =>
    models.filter((m) => m?.name).map((m) => [`${alias}/${m.id}`, m.name])
  )
);

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * GET /v1beta/models - Gemini compatible models list
 *
 * Shares buildModelsList with /v1/models so the Gemini view reflects the same
 * catalog: active connections, enabledModels, custom models, aliases, disabled
 * models, and the requesting API key's allowedModels.
 */
export async function GET(request) {
  try {
    const skipDynamicFetch = request?.headers?.get(INTERNAL_MODELS_FETCH_HEADER) === "1";
    const listed = await filterModelsForApiKey(
      request,
      await buildModelsList(GEMINI_LISTED_KINDS, { skipDynamicFetch })
    );

    const models = [];
    const seen = new Set();

    function addModel({ name, displayName, description, methods = ["generateContent"], inputTokenLimit, outputTokenLimit }) {
      if (seen.has(name)) return;
      seen.add(name);
      models.push({
        name,
        displayName,
        description,
        supportedGenerationMethods: methods,
        inputTokenLimit: inputTokenLimit || DEFAULT_INPUT_TOKEN_LIMIT,
        outputTokenLimit: outputTokenLimit || DEFAULT_OUTPUT_TOKEN_LIMIT,
      });
    }

    for (const model of listed) {
      const alias = model.owned_by || "";
      const modelId = alias && model.id.startsWith(`${alias}/`)
        ? model.id.slice(alias.length + 1)
        : model.id;
      const displayName = STATIC_MODEL_NAMES.get(model.id) || modelId;
      const limits = {
        inputTokenLimit: model.context_length,
        outputTokenLimit: model.max_completion_tokens,
      };

      addModel({
        name: `models/${model.id}`,
        displayName,
        description: `${alias || "9router"} model: ${displayName}`,
        ...limits,
      });

      // Gemini clients also address Google models by their bare id.
      if (alias === "gemini") {
        addModel({
          name: `models/${modelId}`,
          displayName,
          description: `Gemini model: ${displayName}`,
          methods: ["generateContent", "streamGenerateContent"],
          ...limits,
        });
      }
    }

    return Response.json({ models });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json({ error: { message: error.message } }, { status: 500 });
  }
}
