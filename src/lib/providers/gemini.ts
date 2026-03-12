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

/** Gemini 3.x models use thinkingLevel (string enum). */
function getThinkingLevel(complexity: string): string {
  switch (complexity) {
    case "demanding":
      return "high";
    case "standard":
      return "medium";
    default:
      return "low";
  }
}

/** Models that support native image generation via responseModalities. */
const GEMINI_IMAGE_GEN_MODELS = new Set([
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
]);

function buildContents(messages: ConversationMessage[]): Content[] {
  return messages.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }],
  }));
}

export class GeminiProvider implements AIProvider {
  private ai: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("Missing GOOGLE_API_KEY");
    this.ai = new GoogleGenAI({ apiKey });
  }

  async *stream(config: ProviderConfig): AsyncGenerator<ProviderStreamEvent> {
    const isGemini3 = config.modelId.includes("3.") || config.modelId.includes("3-");
    const isGemini25 = config.modelId.includes("2.5");
    const complexity = config.enableThinking ? "demanding" : "standard";

    // Build thinking config based on model generation
    let thinkingConfig: Record<string, unknown> | undefined;
    if (isGemini3) {
      // Gemini 3.x: use thinkingLevel (string enum)
      thinkingConfig = { thinkingLevel: getThinkingLevel(complexity) };
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

    // Only enable responseModalities for models that actually support native image gen
    const supportsImageGen = config.enableImageGeneration && GEMINI_IMAGE_GEN_MODELS.has(config.modelId);

    const response = await this.ai.models.generateContentStream({
      model: config.modelId,
      contents,
      config: {
        systemInstruction: config.systemPrompt,
        ...(tools.length > 0 ? { tools } : {}),
        ...(thinkingConfig ? { thinkingConfig } : {}),
        ...(supportsImageGen
          ? { responseModalities: ["TEXT", "IMAGE"] }
          : {}),
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
}
