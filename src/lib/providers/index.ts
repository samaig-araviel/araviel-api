import type { SupportedProvider } from "@/lib/types";
import type { AIProvider } from "./base";
import { OpenAIProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import { PerplexityProvider } from "./perplexity";

const providerCache: Partial<Record<SupportedProvider, AIProvider>> = {};

export function getProvider(providerName: SupportedProvider): AIProvider {
  if (providerCache[providerName]) {
    return providerCache[providerName];
  }

  let provider: AIProvider;

  switch (providerName) {
    case "openai":
      provider = new OpenAIProvider();
      break;
    case "anthropic":
      provider = new AnthropicProvider();
      break;
    case "google":
      provider = new GeminiProvider();
      break;
    case "perplexity":
      provider = new PerplexityProvider();
      break;
    default:
      throw new Error(`Unsupported provider: ${providerName}`);
  }

  providerCache[providerName] = provider;
  return provider;
}
