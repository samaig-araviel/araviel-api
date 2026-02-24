import { getModelPricing } from "@/config/models";
import type { TokenUsage } from "@/lib/types";

export function calculateCost(
  provider: string,
  modelId: string,
  usage: TokenUsage
): number {
  const pricing = getModelPricing(modelId, provider);

  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
  const reasoningCost = (usage.reasoningTokens / 1_000_000) * pricing.outputPerMillion;

  return parseFloat((inputCost + outputCost + reasoningCost).toFixed(6));
}
