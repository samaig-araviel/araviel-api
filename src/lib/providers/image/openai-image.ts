import OpenAI from "openai";
import type { ImageGenResult } from "./index";
import {
  ImageValidationError,
  validateBackgroundFormat,
  validateImageSize,
  type ImageBackground,
  type ImageOutputFormat,
} from "./validation";

/**
 * Models that use the GPT Image API surface (b64_json by default, no `style`
 * or `response_format` params).
 *
 * gpt-image-2 (released 2026-04-21) is the current flagship — it accepts the
 * same call shape plus optional new params (`background`, `output_format`,
 * `partial_images`, `moderation`) and supports arbitrary WxH sizes within
 * the constraints validated in `./validation.ts`.
 *
 * gpt-image-1 was retired 2026-10-23; requests for it are coerced to
 * gpt-image-2 by `coerceModelId` before they reach this module.
 */
const GPT_IMAGE_MODELS = new Set([
  "gpt-image-2",
  "gpt-image-1.5",
  "gpt-image-1-mini",
]);

export type GptImageQuality = "low" | "medium" | "high" | "auto";

export interface OpenAIImageOptions {
  /** Image quality. Higher quality costs more output tokens. */
  quality?: GptImageQuality;
  /**
   * Output dimensions as "WIDTHxHEIGHT". gpt-image-1.5 and gpt-image-1-mini
   * accept the standard sizes (1024x1024, 1536x1024, 1024x1536).
   * gpt-image-2 additionally accepts arbitrary sizes within OpenAI's
   * documented constraints (see {@link validateImageSize}).
   */
  size?: string;
  /**
   * Background treatment. `"transparent"` requires PNG or WebP output.
   * Supported by all GPT Image models.
   */
  background?: ImageBackground;
  /** Output container format. Supported by all GPT Image models. */
  outputFormat?: ImageOutputFormat;
}

/**
 * Generate an image using an OpenAI GPT Image model.
 *
 * Throws `ImageValidationError` if `size` or `background`/`outputFormat`
 * combinations violate OpenAI's documented constraints. Throws on any
 * upstream API error.
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

  const size = options.size ?? "1024x1024";
  const quality = options.quality ?? "auto";

  validateImageSize(size);
  validateBackgroundFormat(options.background, options.outputFormat);

  const client = new OpenAI({ apiKey });

  // The OpenAI SDK's type for `size` is a fixed union of the standard sizes
  // (1024x1024, 1536x1024, 1024x1536, etc.). gpt-image-2 accepts arbitrary
  // WxH strings at runtime, but the SDK types haven't been widened yet, so a
  // narrow cast is necessary here. `validateImageSize` guarantees the value
  // is well-formed.
  const result = await client.images.generate({
    model: modelId,
    prompt,
    n: 1,
    size: size as "1024x1024",
    quality: quality as "auto",
    ...(options.background ? { background: options.background } : {}),
    ...(options.outputFormat ? { output_format: options.outputFormat } : {}),
  });

  const data = result.data?.[0];
  const b64 = data?.b64_json;
  if (b64) {
    const mime = mimeForFormat(options.outputFormat);
    return { url: `data:${mime};base64,${b64}`, size };
  }

  const url = data?.url;
  if (url) {
    return { url, size };
  }

  throw new Error(`${modelId} returned no image data`);
}

function mimeForFormat(format: ImageOutputFormat | undefined): string {
  switch (format) {
    case "webp":
      return "image/webp";
    case "jpeg":
      return "image/jpeg";
    case "png":
    case undefined:
      return "image/png";
  }
}

export { ImageValidationError };
