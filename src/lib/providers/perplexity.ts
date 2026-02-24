import OpenAI from "openai";
import type { AIProvider, ProviderConfig, ProviderStreamEvent } from "./base";
import type { Citation, ConversationMessage, TokenUsage } from "@/lib/types";

function buildMessages(
  systemPrompt: string,
  messages: ConversationMessage[]
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
  ];

  for (const msg of messages) {
    result.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    });
  }

  return result;
}

export class PerplexityProvider implements AIProvider {
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) throw new Error("Missing PERPLEXITY_API_KEY");
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.perplexity.ai",
    });
  }

  async *stream(config: ProviderConfig): AsyncGenerator<ProviderStreamEvent> {
    const stream = await this.client.chat.completions.create({
      model: config.modelId,
      messages: buildMessages(config.systemPrompt, config.messages),
      stream: true,
    });

    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
    };

    const collectedCitations: Citation[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        yield { type: "delta", content: delta.content };
      }

      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
        usage.outputTokens = chunk.usage.completion_tokens ?? 0;
      }

      const extended = chunk as unknown as Record<string, unknown>;
      if (extended.citations && Array.isArray(extended.citations)) {
        for (const cite of extended.citations as string[]) {
          collectedCitations.push({ url: cite, title: cite });
        }
      }
    }

    if (collectedCitations.length > 0) {
      yield { type: "citations", citations: collectedCitations };
    }

    yield { type: "done", usage };
  }
}
