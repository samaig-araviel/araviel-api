interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  "gpt-5.2": { inputPerMillion: 1.75, outputPerMillion: 14 },
  "gpt-5.2-pro": { inputPerMillion: 21, outputPerMillion: 168 },
  "gpt-5.1": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gpt-5": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gpt-5-mini": { inputPerMillion: 0.25, outputPerMillion: 2 },
  "gpt-5-nano": { inputPerMillion: 0.05, outputPerMillion: 0.4 },
  "gpt-5.1-codex": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gpt-5.1-codex-mini": { inputPerMillion: 0.25, outputPerMillion: 2 },
  "gpt-4.1": { inputPerMillion: 2, outputPerMillion: 8 },
  "gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  "gpt-4.1-nano": { inputPerMillion: 0.1, outputPerMillion: 1.4 },
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "o3": { inputPerMillion: 2, outputPerMillion: 8 },
  "o3-pro": { inputPerMillion: 20, outputPerMillion: 80 },
  "o4-mini": { inputPerMillion: 1.1, outputPerMillion: 4.4 },

  // Anthropic
  "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-5-20251101": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-20250514": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-opus-4-1-20250610": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-sonnet-4-5-20250929": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5-20251001": { inputPerMillion: 1, outputPerMillion: 5 },
  "claude-3-5-haiku-20241022": { inputPerMillion: 0.8, outputPerMillion: 4 },

  // Google Gemini
  "gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gemini-2.5-pro-preview-05-06": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gemini-2.5-flash": { inputPerMillion: 0.075, outputPerMillion: 0.3 },
  "gemini-2.5-flash-preview-04-17": { inputPerMillion: 0.075, outputPerMillion: 0.3 },
  "gemini-2.5-flash-lite": { inputPerMillion: 0.025, outputPerMillion: 0.1 },
  "gemini-2.5-flash-lite-preview-06-17": { inputPerMillion: 0.025, outputPerMillion: 0.1 },

  // Perplexity
  "sonar": { inputPerMillion: 1, outputPerMillion: 1 },
  "sonar-pro": { inputPerMillion: 3, outputPerMillion: 15 },
};

const PROVIDER_DEFAULTS: Record<string, ModelPricing> = {
  openai: { inputPerMillion: 2, outputPerMillion: 8 },
  anthropic: { inputPerMillion: 3, outputPerMillion: 15 },
  google: { inputPerMillion: 1.25, outputPerMillion: 10 },
  perplexity: { inputPerMillion: 1, outputPerMillion: 1 },
};

export function getModelPricing(modelId: string, provider: string): ModelPricing {
  if (MODEL_PRICING[modelId]) {
    return MODEL_PRICING[modelId];
  }

  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelId.startsWith(key) || modelId.includes(key)) {
      return pricing;
    }
  }

  return PROVIDER_DEFAULTS[provider] ?? { inputPerMillion: 2, outputPerMillion: 10 };
}
