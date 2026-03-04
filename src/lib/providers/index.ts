import type { SupportedProvider } from "@/lib/types";
import type { AIProvider } from "./base";
import { OpenAIProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import { PerplexityProvider } from "./perplexity";

const providerCache: Partial<Record<SupportedProvider, AIProvider>> = {};

const PROVIDER_ENV_KEYS: Record<SupportedProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  stability: "STABILITY_API_KEY",
};

/**
 * Returns the list of providers that have API keys configured.
 * Used to tell ADE which providers the backend can actually call.
 */
export function getAvailableProviders(): SupportedProvider[] {
  return (Object.entries(PROVIDER_ENV_KEYS) as [SupportedProvider, string][])
    .filter(([, envKey]) => !!process.env[envKey])
    .map(([provider]) => provider);
}

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
    case "stability":
      // Stability only supports dedicated image generation (via generateImage()),
      // not text streaming. This case should not be reached for streaming calls.
      throw new Error("Stability AI does not support text streaming. Use dedicated image generation instead.");
    default:
      throw new Error(`Unsupported provider: ${providerName}`);
  }

  providerCache[providerName] = provider;
  return provider;
}
