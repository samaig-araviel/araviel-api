import { logger } from "./logger";

/**
 * Map from a retired model ID to its documented replacement.
 *
 * When a client request, stored user preference, or routing decision lands on
 * a retired ID, `coerceModelId` rewrites it to the replacement before the
 * model reaches a provider. This is a safety net so the app keeps working
 * during the transition window between an OpenAI deprecation announcement and
 * its actual shutdown, and for any historical references still in user data.
 *
 * `null` means the model has no replacement and the request should fail
 * upstream (e.g. video generation after Sora 2 was retired).
 *
 * Sources: https://developers.openai.com/api/docs/deprecations
 */
export const RETIRED_MODELS: Readonly<Record<string, string | null>> = Object.freeze({
  // Codex variants — shutdown 2026-07-23
  "gpt-5.1-codex": "gpt-5.3-codex",
  "gpt-5.1-codex-mini": "gpt-5-mini",
  "gpt-5.1-codex-max": "gpt-5.3-codex",
  "gpt-5.2-codex": "gpt-5.3-codex",
  "gpt-5-codex": "gpt-5.3-codex",

  // GPT-4.1 nano — shutdown 2026-10-23
  "gpt-4.1-nano": "gpt-5-nano",

  // GPT Image 1 — shutdown 2026-10-23
  "gpt-image-1": "gpt-image-2",

  // Gemini 3.1 Flash Image preview (Nano Banana 2 preview) — shutdown 2026-06-25
  "gemini-3.1-flash-image-preview": "gemini-3.1-flash-image",

  // Sora 2 / Videos API — shutdown 2026-09-24, no replacement
  "sora-2": null,
  "sora-2-pro": null,

  // Claude Haiku 3.5 — retired from Anthropic-direct API; alive on Bedrock/Vertex
  "claude-3-5-haiku-20241022": "claude-haiku-4-5-20251001",

  // Claude Opus 4.1 — deprecated 2026-06-05, retiring 2026-08-05
  "claude-opus-4-1": "claude-opus-4-7",
  "claude-opus-4-1-20250805": "claude-opus-4-7",
  "claude-opus-4-1-20250610": "claude-opus-4-7",
});

/**
 * Resolve a possibly-retired model ID to its current replacement.
 *
 * Returns the original ID if not retired. When a coerce fires, emits a single
 * `warn` log so we can monitor residual usage of retired IDs in production.
 *
 * Throws `RetiredModelError` if the model has been retired with no
 * replacement available — the caller should map this to a user-facing
 * "feature unavailable" error.
 */
export function coerceModelId(
  modelId: string,
  context?: { route?: string; requestId?: string; userId?: string }
): string {
  if (!(modelId in RETIRED_MODELS)) return modelId;

  const replacement = RETIRED_MODELS[modelId];
  if (replacement === null) {
    throw new RetiredModelError(modelId);
  }

  logger.warn("Coerced retired model ID", {
    ...context,
    retiredModelId: modelId,
    replacementModelId: replacement,
  });
  return replacement;
}

export class RetiredModelError extends Error {
  readonly retiredModelId: string;

  constructor(retiredModelId: string) {
    super(
      `Model "${retiredModelId}" has been retired by the provider and no replacement is available.`
    );
    this.name = "RetiredModelError";
    this.retiredModelId = retiredModelId;
  }
}
