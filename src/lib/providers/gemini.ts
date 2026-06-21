import { GoogleGenAI, type Content, type Part } from "@google/genai";
import type { AIProvider, ProviderConfig, ProviderStreamEvent } from "./base";
import type { Citation, ConversationMessage, TokenUsage } from "@/lib/types";

/** Gemini 2.5 models use thinkingBudget (integer). */
function getThinkingBudget(complexity: string): number {
  switch (complexity) {
    case "demanding":
      return 8192;
    case "standard":
      return 2048;
    default:
      return 0;
  }
}

type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";

const LEVEL_RANK: Readonly<Record<GeminiThinkingLevel, number>> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * Gemini 3.x supported `thinkingLevel` values vary by model. Sending an
 * unsupported level returns a 400 from the API, so we restrict per-model:
 *   - Gemini 3 Pro: only `low` and `high`
 *   - Gemini 3.x Flash and Flash-Lite: `minimal`, `low`, `medium`, `high`
 *   - Other 3.x (e.g. 3.1 Pro): `low`, `medium`, `high`
 */
function getAllowedThinkingLevels(modelId: string): readonly GeminiThinkingLevel[] {
  if (modelId === "gemini-3-pro" || modelId.startsWith("gemini-3-pro-")) {
    return ["low", "high"];
  }
  if (
    modelId.startsWith("gemini-3-flash") ||
    modelId.startsWith("gemini-3.1-flash") ||
    modelId.startsWith("gemini-3.5-flash")
  ) {
    return ["minimal", "low", "medium", "high"];
  }
  return ["low", "medium", "high"];
}

/**
 * Pick the highest allowed level that is ≤ the desired level. If the desired
 * level is below every allowed level (rare — only when the model's floor is
 * higher), fall back to the lowest allowed level.
 */
function clampThinkingLevel(
  desired: GeminiThinkingLevel,
  allowed: readonly GeminiThinkingLevel[]
): GeminiThinkingLevel {
  if (allowed.includes(desired)) return desired;
  const desiredRank = LEVEL_RANK[desired];

  let best: GeminiThinkingLevel | undefined;
  let bestRank = -1;
  for (const candidate of allowed) {
    const rank = LEVEL_RANK[candidate];
    if (rank <= desiredRank && rank > bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }
  if (best) return best;

  return allowed.reduce((lowest, candidate) =>
    LEVEL_RANK[candidate] < LEVEL_RANK[lowest] ? candidate : lowest
  );
}

/** Gemini 3.x models use thinkingLevel (string enum). */
function getThinkingLevel(complexity: string): GeminiThinkingLevel {
  switch (complexity) {
    case "demanding":
      return "high";
    case "standard":
      return "medium";
    default:
      return "low";
  }
}

/**
 * Models that support native image generation via responseModalities.
 *
 * `gemini-3.1-flash-image-preview` was retired 2026-06-25 and is coerced to
 * the GA `gemini-3.1-flash-image` at the api boundary (see retired-models.ts),
 * so the preview ID never reaches this set in practice.
 */
const GEMINI_IMAGE_GEN_MODELS = new Set([
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-image",
  "gemini-3-pro-image-preview",
]);

/**
 * Map our `imageQuality` enum to Gemini's `imageConfig.imageSize`.
 *
 * Gemini image models support 1K, 2K, and 4K; the price scales with
 * resolution ($0.067 / $0.101 / $0.151 per image for Nano Banana 2). We
 * keep the cheapest tier as the default so an unspecified quality doesn't
 * silently upgrade the user's bill.
 */
function mapImageSize(quality?: "standard" | "hd" | "ultra"): string {
  switch (quality) {
    case "ultra":
      return "4K";
    case "hd":
      return "2K";
    case "standard":
    default:
      return "1K";
  }
}

function buildContents(messages: ConversationMessage[]): Content[] {
  return messages.map((msg) => {
    if (msg.images && msg.images.length > 0 && msg.role !== "assistant") {
      const parts: Part[] = [
        ...msg.images.map((img) => ({
          inlineData: {
            mimeType: img.mimeType,
            data: img.dataUri.split(",")[1] ?? "",
          },
        })),
        ...(msg.content ? [{ text: msg.content }] : []),
      ];
      return { role: "user" as const, parts };
    }
    return {
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    };
  }) as Content[];
}

export class GeminiProvider implements AIProvider {
  private ai: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("Missing GOOGLE_API_KEY");
    this.ai = new GoogleGenAI({ apiKey });
  }

  async *stream(config: ProviderConfig): AsyncGenerator<ProviderStreamEvent> {
    if (GEMINI_IMAGE_GEN_MODELS.has(config.modelId)) {
      yield* this.streamImageGen(config);
      return;
    }

    const isGemini3 = config.modelId.includes("3.") || config.modelId.includes("3-");
    const isGemini25 = config.modelId.includes("2.5");
    const complexity = config.enableThinking ? "demanding" : "standard";

    // Build thinking config based on model generation
    let thinkingConfig: Record<string, unknown> | undefined;
    if (isGemini3) {
      // Gemini 3.x: use thinkingLevel (string enum), clamped per-model since
      // valid values differ (e.g. Gemini 3 Pro accepts only `low` and `high`).
      const desired = getThinkingLevel(complexity);
      const allowed = getAllowedThinkingLevels(config.modelId);
      thinkingConfig = { thinkingLevel: clampThinkingLevel(desired, allowed) };
    } else if (isGemini25) {
      // Gemini 2.5: use thinkingBudget (integer), -1 for dynamic
      const budget = config.enableThinking ? getThinkingBudget(complexity) : 0;
      thinkingConfig = { thinkingBudget: budget };
    }

    const tools: Array<{ googleSearch: Record<string, never> }> = [];
    if (config.enableWebSearch) {
      tools.push({ googleSearch: {} });
    }

    const contents = buildContents(config.messages);

    const response = await this.ai.models.generateContentStream({
      model: config.modelId,
      contents,
      config: {
        systemInstruction: config.systemPrompt,
        ...(tools.length > 0 ? { tools } : {}),
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    });

    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
    };

    const collectedCitations: Citation[] = [];

    for await (const chunk of response) {
      const text = chunk.text;
      if (text) {
        yield { type: "delta", content: text };
      }

      const candidates = chunk.candidates;
      if (candidates?.[0]?.content?.parts) {
        for (const part of candidates[0].content.parts) {
          const thoughtPart = part as Part & { thought?: boolean };
          if (thoughtPart.thought && thoughtPart.text) {
            yield { type: "thinking", content: thoughtPart.text };
          }
          // Handle native image generation (inline image data)
          const inlinePart = part as Part & { inlineData?: { mimeType?: string; data?: string } };
          if (inlinePart.inlineData?.data) {
            const mime = inlinePart.inlineData.mimeType ?? "image/png";
            yield { type: "image_generation", imageUrl: `data:${mime};base64,${inlinePart.inlineData.data}` };
          }
        }
      }

      const groundingMetadata = chunk.candidates?.[0]?.groundingMetadata;
      if (groundingMetadata) {
        const metadata = groundingMetadata as {
          groundingChunks?: Array<{
            web?: { uri?: string; title?: string };
          }>;
          groundingSupports?: Array<{
            segment?: { text?: string };
            groundingChunkIndices?: number[];
          }>;
        };
        if (metadata.groundingChunks) {
          // Build a map of chunk index to support snippet text
          const chunkSnippets = new Map<number, string>();
          if (metadata.groundingSupports) {
            for (const support of metadata.groundingSupports) {
              if (support.segment?.text && support.groundingChunkIndices) {
                for (const idx of support.groundingChunkIndices) {
                  if (!chunkSnippets.has(idx)) {
                    chunkSnippets.set(idx, support.segment.text);
                  }
                }
              }
            }
          }

          for (let i = 0; i < metadata.groundingChunks.length; i++) {
            const gc = metadata.groundingChunks[i];
            if (gc.web?.uri) {
              collectedCitations.push({
                url: gc.web.uri,
                title: gc.web.title ?? gc.web.uri,
                snippet: chunkSnippets.get(i),
              });
            }
          }
        }
      }

      if (chunk.usageMetadata) {
        usage.inputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
        usage.outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
        usage.reasoningTokens = (
          chunk.usageMetadata as { thoughtsTokenCount?: number }
        ).thoughtsTokenCount ?? 0;
        usage.cachedTokens = chunk.usageMetadata.cachedContentTokenCount ?? 0;
      }
    }

    const webSearchUsed = collectedCitations.length > 0;
    if (webSearchUsed) {
      usage.webSearchRequests = 1;
    }

    if (collectedCitations.length > 0) {
      yield { type: "citations", citations: collectedCitations };
    }

    yield { type: "done", usage, webSearchUsed };
  }

  /**
   * Gemini image-gen models (Nano Banana family, Gemini 3 Pro Image, etc.) use
   * a non-streaming `generateContent` call per Google's docs. They reject the
   * `thinkingConfig`/`thinkingLevel` knobs the chat models accept (thinking
   * for image gen is automatic), and the system instruction parameter is
   * unused. Tools are limited to grounding which we don't expose here.
   *
   * We request both TEXT and IMAGE modalities so the model can return an
   * optional caption alongside the inline image data; both are yielded as
   * standard ProviderStreamEvents so the chat consumer doesn't need special
   * handling.
   */
  private async *streamImageGen(
    config: ProviderConfig
  ): AsyncGenerator<ProviderStreamEvent> {
    const contents = buildContents(config.messages);

    const response = await this.ai.models.generateContent({
      model: config.modelId,
      contents,
      config: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: {
          imageSize: mapImageSize(config.imageQuality),
          ...(config.imageAspectRatio
            ? { aspectRatio: config.imageAspectRatio }
            : {}),
        },
      },
    });

    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
    };

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      const p = part as Part & {
        thought?: boolean;
        text?: string;
        inlineData?: { mimeType?: string; data?: string };
      };

      if (p.text && !p.thought) {
        yield { type: "delta", content: p.text };
      }
      if (p.inlineData?.data) {
        const mime = p.inlineData.mimeType ?? "image/png";
        yield {
          type: "image_generation",
          imageUrl: `data:${mime};base64,${p.inlineData.data}`,
        };
      }
    }

    if (response.usageMetadata) {
      usage.inputTokens = response.usageMetadata.promptTokenCount ?? 0;
      usage.outputTokens = response.usageMetadata.candidatesTokenCount ?? 0;
      usage.reasoningTokens =
        (response.usageMetadata as { thoughtsTokenCount?: number })
          .thoughtsTokenCount ?? 0;
      usage.cachedTokens =
        response.usageMetadata.cachedContentTokenCount ?? 0;
    }

    yield { type: "done", usage, webSearchUsed: false };
  }
}
