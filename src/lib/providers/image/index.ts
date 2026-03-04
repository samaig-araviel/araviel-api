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
  switch (provider) {
    case "openai":
      return generateOpenAIImage(prompt);
    case "google":
      return generateGoogleImage(modelId, prompt);
    case "stability":
      return generateStabilityImage(prompt);
    default:
      throw new Error(`No image generation support for provider: ${provider}`);
  }
}
