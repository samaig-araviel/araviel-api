import { getModelPricing } from "@/config/models";
import type { TokenUsage } from "@/lib/types";

// Web search cost per request by provider
const WEB_SEARCH_COST_PER_REQUEST: Record<string, number> = {
  // Anthropic: $10 per 1,000 searches = $0.01 per search
  anthropic: 0.01,
  // OpenAI: included in per-token pricing for Responses API
  openai: 0,
  // Google: $35 per 1,000 queries for Gemini grounding
  google: 0.035,
  // Perplexity: included in their pricing tiers
  perplexity: 0,
};

export function calculateCost(
  provider: string,
  modelId: string,
  usage: TokenUsage
): number {
  const pricing = getModelPricing(modelId, provider);

  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
  const reasoningCost = (usage.reasoningTokens / 1_000_000) * pricing.outputPerMillion;
  const webSearchCost = calculateWebSearchCost(provider, usage.webSearchRequests ?? 0);

  return parseFloat((inputCost + outputCost + reasoningCost + webSearchCost).toFixed(6));
}

function calculateWebSearchCost(provider: string, requestCount: number): number {
  if (requestCount === 0) return 0;
  const costPerRequest = WEB_SEARCH_COST_PER_REQUEST[provider] ?? 0;
  return requestCount * costPerRequest;
}
