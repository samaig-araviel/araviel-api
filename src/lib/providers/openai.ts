import OpenAI from "openai";
import type { AIProvider, ProviderConfig, ProviderStreamEvent } from "./base";
import type { Citation, ConversationMessage, TokenUsage } from "@/lib/types";

const REASONING_MODELS = new Set(["o3", "o3-pro", "o4-mini"]);

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
    const isReasoning = REASONING_MODELS.has(config.modelId);

    const tools: OpenAI.Responses.Tool[] = [];
    if (config.enableWebSearch) {
      tools.push({ type: "web_search_preview" });
    }

    const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model: config.modelId,
      input: buildInput(config.messages),
      stream: true,
      ...(tools.length > 0 ? { tools } : {}),
      ...(!isReasoning ? { instructions: config.systemPrompt } : {}),
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

        for (const item of response.output ?? []) {
          if (item.type === "message" && item.content) {
            for (const part of item.content) {
              if (part.type === "output_text" && part.annotations) {
                for (const ann of part.annotations) {
                  if (ann.type === "url_citation") {
                    collectedCitations.push({
                      url: ann.url,
                      title: ann.title ?? ann.url,
                    });
                  }
                }
              }
            }
          }
        }

        if (collectedCitations.length > 0) {
          yield { type: "citations", citations: collectedCitations };
        }

        yield { type: "done", usage };
      }
    }
  }
}
