import { generateOpenAIImage } from "./openai-image";
import { generateGoogleImage } from "./google-image";
import { generateStabilityImage } from "./stability-image";

export interface ImageGenResult {
  url: string;
  size?: string;
  style?: string;
}

/**
 * Generate an image using a dedicated image generation model.
 * Routes to the correct provider-specific implementation based on provider name.
 */
export async function generateImage(
  provider: string,
  modelId: string,
  prompt: string
): Promise<ImageGenResult> {
  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("Image generation prompt must be a non-empty string");
  }

  const trimmedPrompt = prompt.trim();

  switch (provider) {
    case "openai":
      return generateOpenAIImage(modelId, trimmedPrompt);
    case "google":
      return generateGoogleImage(modelId, trimmedPrompt);
    case "stability":
      return generateStabilityImage(trimmedPrompt);
    default:
      throw new Error(`No image generation support for provider: ${provider}`);
  }
}
