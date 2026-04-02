import OpenAI from "openai";
import type { AIProvider, ProviderConfig, ProviderStreamEvent } from "./base";
import type { Citation, ConversationMessage, TokenUsage } from "@/lib/types";

/**
 * Models that support the `image_generation` tool in the Responses API.
 * Per OpenAI docs (March 2026), this tool is available for GPT-4o series,
 * GPT-4.1 series, GPT-5 series, and o3 (only o3 from the o-series; o3-pro
 * and o4-mini do NOT support image_generation).
 * For other models, image generation should be routed to a dedicated image model.
 */
const IMAGE_GEN_TOOL_MODELS = new Set([
  // GPT-4o series
  "gpt-4o",
  "gpt-4o-mini",
  // GPT-4.1 series
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  // GPT-5 series (gpt-5-mini explicitly does NOT support image_generation)
  "gpt-5",
  "gpt-5.2",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5-nano",
  // o-series (only o3 supports image_generation)
  "o3",
]);

/**
 * Deep research models require `web_search_preview` tool and do NOT support
 * streaming.  They use the same Responses API but with `stream: false` and
 * `reasoning.summary` for intermediate reasoning output.
 */
const DEEP_RESEARCH_MODELS = new Set([
  "o3-deep-research",
  "o4-mini-deep-research",
]);

function buildInput(
  messages: ConversationMessage[]
): OpenAI.Responses.ResponseInputItem[] {
  return messages.map((msg) => ({
    role: msg.role === "assistant" ? "assistant" : "user",
    content: msg.content,
    type: "message" as const,
  }));
}

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
    this.client = new OpenAI({ apiKey });
  }

  async *stream(config: ProviderConfig): AsyncGenerator<ProviderStreamEvent> {
    if (DEEP_RESEARCH_MODELS.has(config.modelId)) {
      yield* this.streamDeepResearch(config);
      return;
    }

    const tools: OpenAI.Responses.Tool[] = [];
    if (config.enableWebSearch) {
      tools.push({ type: "web_search_preview" });
    }
    if (config.enableImageGeneration && IMAGE_GEN_TOOL_MODELS.has(config.modelId)) {
      tools.push({ type: "image_generation" } as OpenAI.Responses.Tool);
    }

    const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model: config.modelId,
      input: buildInput(config.messages),
      instructions: config.systemPrompt,
      stream: true,
      ...(tools.length > 0 ? { tools } : {}),
    };

    const stream = await this.client.responses.create(params);

    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
    };

    const collectedCitations: Citation[] = [];

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        yield { type: "delta", content: event.delta };
      } else if (event.type === "response.reasoning_summary_text.delta") {
        yield { type: "thinking", content: event.delta };
      } else if (event.type === "response.completed") {
        const response = event.response;
        if (response.usage) {
          usage.inputTokens = response.usage.input_tokens ?? 0;
          usage.outputTokens = response.usage.output_tokens ?? 0;
          usage.reasoningTokens = response.usage.output_tokens_details?.reasoning_tokens ?? 0;
          usage.cachedTokens = response.usage.input_tokens_details?.cached_tokens ?? 0;
        }

        let webSearchToolUsed = false;
        for (const item of response.output ?? []) {
          if (item.type === "web_search_call") {
            webSearchToolUsed = true;
          }
          // Handle native image generation results
          if (item.type === "image_generation_call") {
            const imageItem = item as typeof item & { result?: string };
            if (imageItem.result) {
              yield { type: "image_generation", imageUrl: `data:image/png;base64,${imageItem.result}` };
            }
          }
          if (item.type === "message" && item.content) {
            for (const part of item.content) {
              if (part.type === "output_text" && part.annotations) {
                for (const ann of part.annotations) {
                  if (ann.type === "url_citation") {
                    const citation = ann as typeof ann & { snippet?: string };
                    collectedCitations.push({
                      url: ann.url,
                      title: ann.title ?? ann.url,
                      snippet: citation.snippet,
                    });
                  }
                }
              }
            }
          }
        }

        const webSearchUsed = collectedCitations.length > 0 || webSearchToolUsed;
        if (webSearchUsed) {
          usage.webSearchRequests = 1;
        }

        if (collectedCitations.length > 0) {
          yield { type: "citations", citations: collectedCitations };
        }

        yield { type: "done", usage, webSearchUsed };
      }
    }
  }

  /**
   * Non-streaming code path for deep research models.
   *
   * Deep research models always require `web_search_preview` and do not support
   * streaming.  The full response is awaited, then parsed into the same
   * `ProviderStreamEvent` sequence that the streaming path produces.
   */
  private async *streamDeepResearch(
    config: ProviderConfig,
  ): AsyncGenerator<ProviderStreamEvent> {
    const tools: OpenAI.Responses.Tool[] = [{ type: "web_search_preview" }];

    const response = await this.client.responses.create({
      model: config.modelId,
      input: buildInput(config.messages),
      instructions: config.systemPrompt,
      stream: false,
      tools,
      reasoning: { summary: "auto" },
    } as OpenAI.Responses.ResponseCreateParamsNonStreaming & { reasoning: { summary: string } });

    const usage: TokenUsage = {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      cachedTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
    };

    const collectedCitations: Citation[] = [];
    let fullText = "";
    let webSearchUsed = false;

    for (const item of response.output ?? []) {
      if (item.type === "web_search_call") {
        webSearchUsed = true;
      }

      // Extract reasoning summaries
      if (item.type === "reasoning") {
        const summaries = (item as typeof item & { summary?: Array<{ type: string; text: string }> }).summary;
        if (Array.isArray(summaries)) {
          for (const s of summaries) {
            if (s.type === "summary_text" && s.text) {
              yield { type: "thinking", content: s.text };
            }
          }
        }
      }

      // Extract final message text and citations
      if (item.type === "message" && item.content) {
        for (const part of item.content) {
          if (part.type === "output_text") {
            fullText += part.text;
            if (part.annotations) {
              for (const ann of part.annotations) {
                if (ann.type === "url_citation") {
                  const citation = ann as typeof ann & { snippet?: string };
                  collectedCitations.push({
                    url: ann.url,
                    title: ann.title ?? ann.url,
                    snippet: citation.snippet,
                  });
                }
              }
            }
          }
        }
      }
    }

    if (fullText) {
      yield { type: "delta", content: fullText };
    }

    if (collectedCitations.length > 0 || webSearchUsed) {
      usage.webSearchRequests = 1;
    }

    if (collectedCitations.length > 0) {
      yield { type: "citations", citations: collectedCitations };
    }

    yield { type: "done", usage, webSearchUsed: collectedCitations.length > 0 || webSearchUsed };
  }
}
