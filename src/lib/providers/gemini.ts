import { GoogleGenAI, type Content, type Part } from "@google/genai";
import type { AIProvider, ProviderConfig, ProviderStreamEvent } from "./base";
import type { Citation, ConversationMessage, TokenUsage } from "@/lib/types";

function getThinkingBudget(complexity: string, enableThinking: boolean): number | undefined {
  if (!enableThinking) return 0;
  switch (complexity) {
    case "demanding":
      return 4096;
    case "standard":
      return 1024;
    default:
      return 0;
  }
}

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
    const isFlashModel = config.modelId.includes("flash");
    const thinkingBudget = getThinkingBudget(
      config.enableThinking ? "demanding" : "standard",
      config.modelId.includes("2.5")
    );

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
        ...(thinkingBudget !== undefined && !isFlashModel
          ? { thinkingConfig: { thinkingBudget } }
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
