import { NextRequest } from "next/server";
import { callADE } from "@/lib/ade";
import { calculateCost } from "@/lib/cost";
import { getProvider } from "@/lib/providers";
import { createSSEStream, sendSSE } from "@/lib/stream/normalizer";
import type { SupportedProvider, StreamEvent, TokenUsage, ModelInfo, ADEAnalysis } from "@/lib/types";
import { SUPPORTED_PROVIDERS } from "@/lib/types";
import {
  validateChatRequest,
  getOrCreateConversation,
  saveUserMessage,
  createAssistantMessage,
  updateAssistantMessage,
  updateConversationTimestamp,
  saveRoutingLog,
  saveApiCallLog,
  fetchConversationHistory,
  getPreviousModelId,
  resolveModel,
  buildSystemPrompt,
  shouldEnableWebSearch,
  shouldEnableThinking,
  findSupportedBackup,
} from "@/lib/chat-helpers";
import { corsHeaders, handleCorsOptions } from "../cors";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function POST(request: NextRequest) {
  const { stream, writer, encoder } = createSSEStream();

  const response = new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });

  handleChat(request, writer, encoder).catch(async (err) => {
    const errorEvent: StreamEvent = {
      type: "error",
      data: {
        message: err instanceof Error ? err.message : "Internal server error",
        code: "INTERNAL_ERROR",
      },
    };
    try {
      await sendSSE(writer, encoder, errorEvent);
    } catch {
      // Writer may already be closed
    }
    try {
      await writer.close();
    } catch {
      // Already closed
    }
  });

  return response;
}

async function handleChat(
  request: NextRequest,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder
): Promise<void> {
  try {
    // 1. Parse and validate
    const body = await request.json();
    const chatReq = validateChatRequest(body);

    // 2. Get or create conversation
    const conversationId = await getOrCreateConversation(
      chatReq.conversationId,
      chatReq.message
    );

    // 3. Save user message
    await saveUserMessage(conversationId, chatReq.message);

    // 4. Fetch conversation history
    const history = await fetchConversationHistory(conversationId);

    // 5. Get previous model for conversation coherence
    const previousModelUsed = await getPreviousModelId(conversationId);

    // 6. Call ADE
    const { response: adeResponse, latencyMs: adeLatencyMs } = await callADE({
      prompt: chatReq.message,
      modality: chatReq.modality ?? "text",
      userTier: chatReq.userTier ?? "free",
      context: {
        conversationId,
        previousModelUsed,
      },
    });

    // 7. Check for fallback (unsupported task)
    if (adeResponse.fallback && !adeResponse.fallback.supported === false) {
      // fallback.supported === false means ADE couldn't find a model
    }
    if (adeResponse.fallback && adeResponse.fallback.message) {
      await sendSSE(writer, encoder, {
        type: "error",
        data: {
          message: adeResponse.fallback.message,
          code: "UNSUPPORTED_TASK",
          category: adeResponse.fallback.category,
          suggestedPlatforms: adeResponse.fallback.suggestedPlatforms,
        },
      });
      await writer.close();
      return;
    }

    // 8. Resolve model (handle manual selection and unsupported providers)
    let resolved: ReturnType<typeof resolveModel>;
    try {
      resolved = resolveModel(adeResponse, chatReq.selectedModelId);
    } catch {
      await sendSSE(writer, encoder, {
        type: "error",
        data: {
          message: "No supported AI provider available for this request.",
          code: "NO_PROVIDER",
        },
      });
      await writer.close();
      return;
    }

    const { model, backupModels, isManualSelection } = resolved;

    // 9. Create assistant message record (empty, to get messageId)
    const messageId = await createAssistantMessage(conversationId);

    // 10. Save routing log
    await saveRoutingLog(messageId, adeResponse, adeLatencyMs);

    // 11. Send routing event
    await sendSSE(writer, encoder, {
      type: "routing",
      data: {
        conversationId,
        messageId,
        model,
        backupModels,
        analysis: {
          intent: adeResponse.analysis.intent,
          domain: adeResponse.analysis.domain,
          complexity: adeResponse.analysis.complexity,
        },
        confidence: adeResponse.confidence,
        adeLatencyMs,
        isManualSelection,
        upgradeHint: adeResponse.upgradeHint ?? null,
      },
    });

    // 12. Stream from provider
    const systemPrompt = buildSystemPrompt();
    const enableWebSearch = shouldEnableWebSearch(adeResponse.analysis);
    const enableThinking = shouldEnableThinking(adeResponse.analysis);

    const streamResult = await streamFromProvider(
      model,
      systemPrompt,
      history,
      enableWebSearch,
      enableThinking,
      writer,
      encoder,
      messageId
    );

    // 13. If primary failed, try backup
    if (!streamResult.success) {
      const backup = findSupportedBackup(backupModels);

      if (backup) {
        await sendSSE(writer, encoder, {
          type: "error",
          data: {
            message: `Retrying with backup model ${backup.name}...`,
            code: "PROVIDER_RETRY",
          },
        });

        const backupResult = await streamFromProvider(
          backup,
          systemPrompt,
          history,
          enableWebSearch,
          enableThinking,
          writer,
          encoder,
          messageId
        );

        if (!backupResult.success) {
          await sendSSE(writer, encoder, {
            type: "error",
            data: {
              message: "Both primary and backup models failed. Please try again.",
              code: "ALL_PROVIDERS_FAILED",
            },
          });
          await writer.close();
          return;
        }

        await finalize(
          messageId,
          conversationId,
          backupResult,
          backup,
          backupModels,
          adeResponse,
          adeLatencyMs,
          writer,
          encoder
        );
      } else {
        await sendSSE(writer, encoder, {
          type: "error",
          data: {
            message: "Provider failed and no backup model is available.",
            code: "PROVIDER_ERROR",
          },
        });
        await writer.close();
        return;
      }
    } else {
      await finalize(
        messageId,
        conversationId,
        streamResult,
        model,
        backupModels,
        adeResponse,
        adeLatencyMs,
        writer,
        encoder
      );
    }
  } catch (err) {
    await sendSSE(writer, encoder, {
      type: "error",
      data: {
        message: err instanceof Error ? err.message : "Internal server error",
        code: "INTERNAL_ERROR",
      },
    });
    await writer.close();
  }
}

interface StreamResult {
  success: boolean;
  content: string;
  thinkingContent: string;
  citations: Array<{ url: string; title: string }>;
  usage: TokenUsage;
  latencyMs: number;
  error?: string;
}

async function streamFromProvider(
  model: ModelInfo,
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  enableWebSearch: boolean,
  enableThinking: boolean,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  messageId: string
): Promise<StreamResult> {
  const start = Date.now();
  let content = "";
  let thinkingContent = "";
  const citations: Array<{ url: string; title: string }> = [];
  let usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
  };

  try {
    if (!SUPPORTED_PROVIDERS.has(model.provider)) {
      throw new Error(`Unsupported provider: ${model.provider}`);
    }

    const provider = getProvider(model.provider as SupportedProvider);
    const providerStream = provider.stream({
      modelId: model.id,
      systemPrompt,
      messages: history.map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      })),
      enableThinking,
      enableWebSearch,
    });

    for await (const event of providerStream) {
      switch (event.type) {
        case "delta":
          if (event.content) {
            content += event.content;
            await sendSSE(writer, encoder, {
              type: "delta",
              data: { content: event.content },
            });
          }
          break;
        case "thinking":
          if (event.content) {
            thinkingContent += event.content;
            await sendSSE(writer, encoder, {
              type: "thinking",
              data: { content: event.content },
            });
          }
          break;
        case "citations":
          if (event.citations) {
            citations.push(...event.citations);
            await sendSSE(writer, encoder, {
              type: "citations",
              data: { citations: event.citations },
            });
          }
          break;
        case "tool_use":
          await sendSSE(writer, encoder, {
            type: "tool_use",
            data: { tool: event.tool, status: event.status },
          });
          break;
        case "done":
          if (event.usage) {
            usage = event.usage;
          }
          break;
        case "error":
          throw new Error(event.error ?? "Provider stream error");
      }
    }

    const latencyMs = Date.now() - start;

    await saveApiCallLog(messageId, model.provider, model.id, 200, latencyMs);

    return {
      success: true,
      content,
      thinkingContent,
      citations,
      usage,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const errorMessage = err instanceof Error ? err.message : "Unknown provider error";

    await saveApiCallLog(
      messageId,
      model.provider,
      model.id,
      500,
      latencyMs,
      errorMessage
    );

    return {
      success: false,
      content,
      thinkingContent,
      citations,
      usage,
      latencyMs,
      error: errorMessage,
    };
  }
}

async function finalize(
  messageId: string,
  conversationId: string,
  result: StreamResult,
  model: ModelInfo,
  backupModels: ModelInfo[],
  adeResponse: { analysis: ADEAnalysis },
  adeLatencyMs: number,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder
): Promise<void> {
  const costUsd = calculateCost(model.provider, model.id, result.usage);

  const modelUsed = {
    model: {
      id: model.id,
      name: model.name,
      provider: model.provider,
      score: model.score,
      reasoning: model.reasoning,
    },
    backupModels,
    analysis: adeResponse.analysis,
  };

  const extendedData: Record<string, unknown> = {};
  if (result.thinkingContent) {
    extendedData.thinkingContent = result.thinkingContent;
  }
  if (result.citations.length > 0) {
    extendedData.citations = result.citations;
  }

  await updateAssistantMessage(messageId, {
    content: result.content,
    modelUsed,
    usage: result.usage,
    costUsd,
    latencyMs: result.latencyMs,
    adeLatencyMs,
    extendedData,
  });

  await updateConversationTimestamp(conversationId);

  await sendSSE(writer, encoder, {
    type: "done",
    data: {
      messageId,
      conversationId,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        reasoningTokens: result.usage.reasoningTokens,
        cachedTokens: result.usage.cachedTokens,
        costUsd,
      },
      latencyMs: result.latencyMs,
      adeLatencyMs,
    },
  });

  await writer.close();
}
