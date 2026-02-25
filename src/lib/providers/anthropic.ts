import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider, ProviderConfig, ProviderStreamEvent } from "./base";
import type { Citation, ConversationMessage, TokenUsage } from "@/lib/types";

const THINKING_MODELS = new Set([
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
]);

function buildMessages(
  messages: ConversationMessage[]
): Anthropic.MessageParam[] {
  return messages.map((msg) => ({
    role: msg.role === "assistant" ? "assistant" : "user",
    content: msg.content,
  }));
}

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");
    this.client = new Anthropic({ apiKey });
  }

  async *stream(config: ProviderConfig): AsyncGenerator<ProviderStreamEvent> {
    const supportsThinking = THINKING_MODELS.has(config.modelId);
    const useThinking = config.enableThinking && supportsThinking;

    const tools: Anthropic.Tool[] = [];
    if (config.enableWebSearch) {
      tools.push({
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 5,
      } as unknown as Anthropic.Tool);
    }

    const maxTokens = useThinking ? 16384 : 8192;

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: config.modelId,
      max_tokens: maxTokens,
      system: config.systemPrompt,
      messages: buildMessages(config.messages),
      stream: true,
      ...(tools.length > 0 ? { tools } : {}),
      ...(useThinking
        ? { thinking: { type: "enabled", budget_tokens: 10000 } }
        : {}),
    };

    const stream = this.client.messages.stream(params);

    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
    };

    const collectedCitations: Citation[] = [];

    for await (const event of stream) {
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "delta", content: event.delta.text };
        } else if (event.delta.type === "thinking_delta") {
          yield { type: "thinking", content: event.delta.thinking };
        }
      } else if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          yield {
            type: "tool_use",
            tool: event.content_block.name,
            status: "searching",
          };
        }
      }
    }

    const finalMessage = await stream.finalMessage();

    if (finalMessage.usage) {
      usage.inputTokens = finalMessage.usage.input_tokens ?? 0;
      usage.outputTokens = finalMessage.usage.output_tokens ?? 0;
      usage.cachedTokens =
        (
          finalMessage.usage as Anthropic.Usage & {
            cache_read_input_tokens?: number;
          }
        ).cache_read_input_tokens ?? 0;
    }

    // Track web search requests from server tool usage
    const serverToolUse = (
      finalMessage.usage as unknown as Record<string, unknown>
    )?.server_tool_use as { web_search_requests?: number } | undefined;
    const webSearchRequests = serverToolUse?.web_search_requests ?? 0;
    if (webSearchRequests > 0) {
      usage.webSearchRequests = webSearchRequests;
    }

    for (const block of finalMessage.content) {
      if (block.type === "web_search_tool_result") {
        const searchBlock = block as unknown as {
          type: "web_search_tool_result";
          content: Array<{
            type: string;
            url?: string;
            title?: string;
            snippet?: string;
            cited_text?: string;
          }>;
        };
        for (const result of searchBlock.content ?? []) {
          if (result.type === "web_search_result" && result.url) {
            collectedCitations.push({
              url: result.url,
              title: result.title ?? result.url,
              snippet: result.cited_text ?? result.snippet,
            });
          }
        }
      }
    }

    const webSearchUsed = collectedCitations.length > 0 || webSearchRequests > 0;

    if (collectedCitations.length > 0) {
      yield { type: "citations", citations: collectedCitations };
    }

    yield { type: "done", usage, webSearchUsed };
  }
}
