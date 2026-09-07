// Detect free models from a provider's raw /models payload.
// Providers disagree on shape: OpenRouter/chutes send `pricing.{prompt,completion}`
// as decimal strings, LiteLLM-style gateways send `input_cost_per_token`, and many
// send no pricing at all — those stay "unknown" instead of being guessed as paid.

// "deepseek-r1:free", "glm-4.6-free" — the separator stops "freeform" matching.
const FREE_ID_RE = /[:\-_]free\b/i;

// Per-token price keys only. Deliberately skips `request`/`image` so a text model
// that is free per token isn't marked paid by an unrelated image surcharge.
const PRICING_KEYS = ["prompt", "completion", "input", "output"];
const FLAT_PRICE_KEYS = ["input_cost_per_token", "output_cost_per_token"];

function parsePrice(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {object} model - one entry from a provider's /models response
 * @returns {boolean|null} true = free, false = paid, null = provider gave no price info
 */
export function isFreeModel(model) {
  const id = model?.id || model?.name || model?.model;
  if (typeof id === "string" && FREE_ID_RE.test(id)) return true;

  const prices = [];
  const pricing = model?.pricing;
  if (pricing && typeof pricing === "object") {
    for (const key of PRICING_KEYS) {
      const price = parsePrice(pricing[key]);
      if (price !== null) prices.push(price);
    }
  }
  for (const key of FLAT_PRICE_KEYS) {
    const price = parsePrice(model?.[key]);
    if (price !== null) prices.push(price);
  }

  if (prices.length === 0) return null;
  return prices.every((price) => price === 0);
}
