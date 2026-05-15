/**
 * Validators for OpenAI Image API request parameters.
 *
 * Per OpenAI docs (developers.openai.com/api/docs/guides/image-generation),
 * gpt-image-2 accepts arbitrary WxH sizes with these constraints:
 *   - Both dimensions must be divisible by 16
 *   - Aspect ratio must be between 1:3 and 3:1
 *   - Maximum resolution: 3840x2160
 *
 * Some param combinations are also invalid — for example,
 * `background: "transparent"` requires `output_format` to be png or webp;
 * jpeg cannot represent transparency.
 *
 * Validation runs before the API call so we fail fast on the client side
 * rather than wasting an OpenAI request and quota.
 */

const MIN_DIMENSION = 16;
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;
const MIN_ASPECT = 1 / 3;
const MAX_ASPECT = 3;

const SIZE_RE = /^(\d+)x(\d+)$/;

export type ImageBackground = "transparent" | "opaque" | "auto";
export type ImageOutputFormat = "png" | "webp" | "jpeg";

export class ImageValidationError extends Error {
  readonly field: string;
  readonly received: unknown;
  readonly expected: string;

  constructor(field: string, received: unknown, expected: string) {
    super(`Invalid ${field}: received ${JSON.stringify(received)}, expected ${expected}.`);
    this.name = "ImageValidationError";
    this.field = field;
    this.received = received;
    this.expected = expected;
  }
}

/**
 * Validate a size string (e.g. "1024x1024" or "1536x864").
 *
 * Returns the parsed dimensions on success. Throws `ImageValidationError`
 * with a precise reason on failure.
 */
export function validateImageSize(size: string): { width: number; height: number } {
  const match = SIZE_RE.exec(size);
  if (!match) {
    throw new ImageValidationError("size", size, 'format "WIDTHxHEIGHT" (e.g. "1024x1024")');
  }

  const width = Number(match[1]);
  const height = Number(match[2]);

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ImageValidationError("size", size, "positive integer dimensions");
  }

  if (width % MIN_DIMENSION !== 0 || height % MIN_DIMENSION !== 0) {
    throw new ImageValidationError(
      "size",
      size,
      `both dimensions divisible by ${MIN_DIMENSION}`
    );
  }

  if (width > MAX_WIDTH || height > MAX_HEIGHT) {
    throw new ImageValidationError(
      "size",
      size,
      `maximum ${MAX_WIDTH}x${MAX_HEIGHT}`
    );
  }

  const aspect = width / height;
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) {
    throw new ImageValidationError(
      "size",
      size,
      "aspect ratio between 1:3 and 3:1"
    );
  }

  return { width, height };
}

/**
 * Validate that `background` and `output_format` are compatible.
 *
 * Transparent backgrounds are only supported by PNG and WebP — JPEG has no
 * alpha channel.
 */
export function validateBackgroundFormat(
  background: ImageBackground | undefined,
  outputFormat: ImageOutputFormat | undefined
): void {
  if (background === "transparent" && outputFormat === "jpeg") {
    throw new ImageValidationError(
      "background",
      background,
      'output_format "png" or "webp" when background is "transparent"'
    );
  }
}
