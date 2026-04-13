import OpenAI from "openai";
import type { ImageGenResult } from "./index";

/** Models that use the GPT Image API surface (b64_json, no style param). */
const GPT_IMAGE_MODELS = new Set([
  "gpt-image-1",
  "gpt-image-1.5",
  "gpt-image-1-mini",
]);

/** Quality mapping for GPT Image models. */
type GptImageQuality = "low" | "medium" | "high" | "auto";

interface OpenAIImageOptions {
  quality?: GptImageQuality;
  size?: string;
}

/**
 * Generate an image using an OpenAI GPT Image model.
 */
export async function generateOpenAIImage(
  modelId: string,
  prompt: string,
  options: OpenAIImageOptions = {}
): Promise<ImageGenResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  if (!GPT_IMAGE_MODELS.has(modelId)) {
    throw new Error(`Unsupported OpenAI image model: ${modelId}`);
  }

  const client = new OpenAI({ apiKey });
  return generateGptImage(client, modelId, prompt, options);
}

/**
 * GPT Image models (gpt-image-1, gpt-image-1.5, gpt-image-1-mini).
 * These return b64_json by default and do not support `style` or `response_format`.
 */
async function generateGptImage(
  client: OpenAI,
  modelId: string,
  prompt: string,
  options: OpenAIImageOptions
): Promise<ImageGenResult> {
  const size = options.size ?? "1024x1024";
  const quality = (options.quality as GptImageQuality) ?? "auto";

  const result = await client.images.generate({
    model: modelId,
    prompt,
    n: 1,
    size: size as "1024x1024",
    quality: quality as "standard",
  });

  const b64 = result.data?.[0]?.b64_json;
  if (b64) {
    return { url: `data:image/png;base64,${b64}`, size };
  }

  // Fallback: some configurations may return a URL
  const url = result.data?.[0]?.url;
  if (url) {
    return { url, size };
  }

  throw new Error(`${modelId} returned no image data`);
}
