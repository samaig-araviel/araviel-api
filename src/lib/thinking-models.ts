/**
 * Single source of truth for which models the backend treats as
 * thinking-capable per provider. Consumed by:
 *   - Provider stream() implementations to gate the thinking parameter.
 *   - Chat orchestration (chat-helpers) to steer model selection when the
 *     user activates a reasoning toggle in the frontend "Research" dropdown.
 */

/** Provider targets that the dropdown's three reasoning toggles route to. */
export type ThinkingTargetProvider = "anthropic" | "openai" | "google";

/** Anthropic Claude models that accept any form of the `thinking` parameter. */
export const ANTHROPIC_THINKING_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
]);

/**
 * Anthropic models that support adaptive thinking (preferred over the legacy
 * `budget_tokens` shape). Opus 4.7 rejects `budget_tokens` entirely.
 */
export const ANTHROPIC_ADAPTIVE_THINKING_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
]);

/**
 * OpenAI models purpose-built for deep research. They use a non-streaming
 * background-polling path with mandatory `web_search_preview` and require a
 * separate system-prompt suffix. GPT-5.5 Pro is included because the provider
 * does not support streaming for that SKU — background polling is the
 * recommended call shape per OpenAI's docs.
 */
export const OPENAI_DEEP_RESEARCH_MODELS: ReadonlySet<string> = new Set([
  "o3-deep-research",
  "o4-mini-deep-research",
  "gpt-5.5-pro",
]);

/**
 * Default model used when the user activates a reasoning toggle but neither
 * the ADE primary nor any backup is a thinking-capable model from the
 * matching provider. These IDs match entries in the corresponding
 * thinking-capable sets above so the provider implementation will honor the
 * thinking parameter once selected.
 */
export const DEFAULT_THINKING_MODELS: Readonly<
  Record<ThinkingTargetProvider, { readonly id: string; readonly name: string }>
> = {
  anthropic: { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  openai: { id: "o3-deep-research", name: "o3 Deep Research" },
  google: { id: "gemini-3-pro", name: "Gemini 3 Pro" },
};

/**
 * User-facing label for each reasoning toggle. Used in retry/downgrade
 * notifications so the message names the specific mode the user activated
 * (e.g. "Extended Thinking is off for this response") instead of a generic
 * "thinking" label. Mirrors the frontend dropdown copy in
 * `araviel-web/src/components/MainContent/MainContent.jsx` MODE_CONFIG.
 */
export const RESEARCH_MODE_LABELS: Readonly<Record<ThinkingTargetProvider, string>> = {
  anthropic: "Extended Thinking",
  openai: "Deep Research",
  google: "Thinking Mode",
};

/**
 * Whether a Gemini model has any form of thinking support. Gemini 2.5 uses
 * `thinkingBudget`; Gemini 3.x uses `thinkingLevel`; older generations have
 * neither. The provider implementation handles the parameter-shape split —
 * this predicate exists for orchestration where the distinction doesn't
 * matter.
 */
export function isGeminiThinkingCapable(modelId: string): boolean {
  return (
    modelId.startsWith("gemini-3-") ||
    modelId.startsWith("gemini-3.") ||
    modelId.startsWith("gemini-2.5")
  );
}

/**
 * Whether the given model honors the thinking semantics implied by a specific
 * dropdown toggle. The override uses this to prefer thinking-capable backups
 * over arbitrary same-provider models — picking a non-thinking-capable model
 * would silently downgrade the toggle since the provider implementation
 * wouldn't enable thinking on it.
 */
export function isPreferredThinkingModel(
  modelId: string,
  target: ThinkingTargetProvider
): boolean {
  if (target === "anthropic") return ANTHROPIC_THINKING_MODELS.has(modelId);
  if (target === "openai") return OPENAI_DEEP_RESEARCH_MODELS.has(modelId);
  return isGeminiThinkingCapable(modelId);
}
