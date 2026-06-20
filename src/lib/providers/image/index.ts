import { generateOpenAIImage } from "./openai-image";
import { generateGoogleImage } from "./google-image";
import { generateStabilityImage } from "./stability-image";
import type { ImageAspectRatio } from "@/lib/image-aspect-ratio";

export interface ImageGenResult {
  url: string;
  size?: string;
  style?: string;
}

export type ImageQuality = "standard" | "hd" | "ultra";

export interface ImageGenOptions {
  quality?: ImageQuality;
  aspectRatio?: ImageAspectRatio;
}

/**
 * Generate an image using a dedicated image generation model.
 * Routes to the correct provider-specific implementation based on provider name.
 */
export async function generateImage(
  provider: string,
  modelId: string,
  prompt: string,
  options: ImageGenOptions = {}
): Promise<ImageGenResult> {
  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("Image generation prompt must be a non-empty string");
  }

  const trimmedPrompt = prompt.trim();
  const quality = options.quality ?? "standard";
  const aspectRatio = options.aspectRatio;

  switch (provider) {
    case "openai":
      return generateOpenAIImage(modelId, trimmedPrompt, {
        quality: mapOpenAIQuality(modelId, quality) as "low" | "medium" | "high" | "auto",
        size: aspectRatioToOpenAISize(aspectRatio),
      });
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

/**
 * Map our aspect-ratio enum to an OpenAI gpt-image-2 `size` string. All
 * returned dimensions are divisible by 16 and within OpenAI's documented
 * 1:3 – 3:1 aspect-ratio range (see {@link validateImageSize}). For the
 * extreme 21:9 / 9:21 ratios we use the closest valid rectangle.
 */
function aspectRatioToOpenAISize(aspectRatio?: ImageAspectRatio): string {
  switch (aspectRatio) {
    case "16:9":
      return "1536x864";
    case "9:16":
      return "864x1536";
    case "4:3":
      return "1280x960";
    case "3:4":
      return "960x1280";
    case "21:9":
      return "1792x768";
    case "9:21":
      return "768x1792";
    case "1:1":
    default:
      return "1024x1024";
  }
}
