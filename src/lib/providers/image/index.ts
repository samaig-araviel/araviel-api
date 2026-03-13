import { generateOpenAIImage } from "./openai-image";
import { generateGoogleImage } from "./google-image";
import { generateStabilityImage } from "./stability-image";

export interface ImageGenResult {
  url: string;
  size?: string;
  style?: string;
}

/** Maximum prompt length sent to image generation APIs. */
const MAX_PROMPT_LENGTH = 4000;

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

  const sanitizedPrompt = prompt.trim().slice(0, MAX_PROMPT_LENGTH);

  switch (provider) {
    case "openai":
      return generateOpenAIImage(modelId, sanitizedPrompt);
    case "google":
      return generateGoogleImage(modelId, sanitizedPrompt);
    case "stability":
      return generateStabilityImage(sanitizedPrompt);
    default:
      throw new Error(`No image generation support for provider: ${provider}`);
  }
}
