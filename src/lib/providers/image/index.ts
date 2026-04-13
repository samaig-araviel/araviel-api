import { generateOpenAIImage } from "./openai-image";
import { generateGoogleImage } from "./google-image";
import { generateStabilityImage } from "./stability-image";

export interface ImageGenResult {
  url: string;
  size?: string;
  style?: string;
}

export type ImageQuality = "standard" | "hd" | "ultra";

/**
 * Generate an image using a dedicated image generation model.
 * Routes to the correct provider-specific implementation based on provider name.
 */
export async function generateImage(
  provider: string,
  modelId: string,
  prompt: string,
  quality: ImageQuality = "standard"
): Promise<ImageGenResult> {
  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("Image generation prompt must be a non-empty string");
  }

  const trimmedPrompt = prompt.trim();

  switch (provider) {
    case "openai":
      return generateOpenAIImage(modelId, trimmedPrompt, { quality: mapOpenAIQuality(modelId, quality) as "low" | "medium" | "high" | "auto" });
    case "google":
      return generateGoogleImage(modelId, trimmedPrompt);
    case "stability":
      return generateStabilityImage(trimmedPrompt);
    default:
      throw new Error(`No image generation support for provider: ${provider}`);
  }
}

/** Map our quality levels to OpenAI GPT Image quality parameters */
function mapOpenAIQuality(_modelId: string, quality: ImageQuality): string {
  // GPT Image models use: low, medium, high, auto
  switch (quality) {
    case "standard": return "medium";
    case "hd": return "high";
    case "ultra": return "high";
    default: return "auto";
  }
}
