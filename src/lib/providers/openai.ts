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
   * streaming.  The job is submitted with `background: true` (returns immediately),
   * then polled via `responses.retrieve()` until it reaches a terminal state.
   *
   * During polling, research_status events are emitted so the frontend can show
   * live progress (similar to how ChatGPT shows "Searching...", "Reading...", etc).
   */
  private async *streamDeepResearch(
    config: ProviderConfig,
  ): AsyncGenerator<ProviderStreamEvent> {
    const tools: OpenAI.Responses.Tool[] = [{ type: "web_search_preview" }];

    // Submit as a background job — returns immediately with status "queued"
    let response = await this.client.responses.create({
      model: config.modelId,
      input: buildInput(config.messages),
      instructions: config.systemPrompt,
      stream: false,
      tools,
      reasoning: { summary: "auto" },
      background: true,
    });

    // Emit initial queued status so the frontend immediately shows progress
    yield {
      type: "research_status",
      researchStatus: "queued",
      researchSources: 0,
      researchActions: [],
    };

    // Poll until the research reaches a terminal state, emitting progress on each poll
    const POLL_INTERVAL_MS = 2_000;
    let previousOutputLength = 0;
    let totalSources = 0;
    const seenActions: Array<{ type: string; query?: string; url?: string }> = [];

    while (response.status === "queued" || response.status === "in_progress") {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      response = await this.client.responses.retrieve(response.id);

      // Extract new output items added since last poll for progress reporting
      const output = (response as unknown as { output?: Array<Record<string, unknown>> }).output ?? [];
      if (output.length > previousOutputLength) {
        for (let i = previousOutputLength; i < output.length; i++) {
          const item = output[i] as Record<string, unknown>;
          if (item.type === "web_search_call") {
            totalSources++;
            const action: { type: string; query?: string; url?: string } = { type: "search" };
            // Extract search action details — the item may have action.query or action.url
            const actionData = item.action as Record<string, unknown> | undefined;
            if (actionData) {
              if (actionData.query) action.query = String(actionData.query);
              if (actionData.url) action.url = String(actionData.url);
            }
            seenActions.push(action);
          }
        }
        previousOutputLength = output.length;
      }

      // Determine human-readable status phase
      let statusPhase: string;
      if (response.status === "queued") {
        statusPhase = "queued";
      } else if (totalSources === 0) {
        statusPhase = "planning";
      } else {
        statusPhase = "researching";
      }

      yield {
        type: "research_status",
        researchStatus: statusPhase,
        researchSources: totalSources,
        researchActions: seenActions.slice(-5), // Send last 5 actions for UI display
      };
    }

    if (response.status !== "completed") {
      const errMsg = response.error?.message ?? `Research ${response.status}`;
      throw new Error(errMsg);
    }

    // Emit a final "synthesizing" status before parsing results
    yield {
      type: "research_status",
      researchStatus: "synthesizing",
      researchSources: totalSources,
      researchActions: [],
    };

    // Parse the completed response into the same event format as the streaming path
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

      if (item.type === "reasoning") {
        const reasoningItem = item as typeof item & { summary?: Array<{ type: string; text: string }> };
        if (Array.isArray(reasoningItem.summary)) {
          for (const s of reasoningItem.summary) {
            if (s.type === "summary_text" && s.text) {
              yield { type: "thinking", content: s.text };
            }
          }
        }
      }

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
