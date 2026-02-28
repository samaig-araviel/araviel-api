import { NextRequest } from "next/server";
import { callADE } from "@/lib/ade";
import { calculateCost } from "@/lib/cost";
import { getProvider, getAvailableProviders } from "@/lib/providers";
import { createSSEStream, sendSSE } from "@/lib/stream/normalizer";
import type { SupportedProvider, StreamEvent, TokenUsage, ModelInfo, ADEResponse } from "@/lib/types";
import { SUPPORTED_PROVIDERS } from "@/lib/types";
import { randomUUID } from "crypto";
import {
  validateChatRequest,
  getOrCreateConversation,
  saveUserMessage,
  insertAssistantMessage,
  updateConversationTimestamp,
  saveRoutingLog,
  saveApiCallLog,
  fetchConversationHistory,
  getPreviousModelId,
  resolveModel,
  buildSystemPrompt,
  resolveWebSearch,
  shouldEnableThinking,
  findSupportedBackup,
  validateSubConversation,
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

    // 2. Get or create conversation (for sub-conversations, validate and use the parent conversation)
    let conversationId: string;
    const subConversationId = chatReq.subConversationId;

    if (subConversationId) {
      const subConv = await validateSubConversation(subConversationId);
      conversationId = subConv.conversationId;
    } else {
      conversationId = await getOrCreateConversation(
        chatReq.conversationId,
        chatReq.message
      );
    }

    // 3. Save user message
    await saveUserMessage(conversationId, chatReq.message, subConversationId);

    // 4. Fetch conversation history (sub-conversation history includes highlighted text context)
    const history = await fetchConversationHistory(conversationId, subConversationId);

    // 5. Get previous model for conversation coherence
    const previousModelUsed = await getPreviousModelId(conversationId);

    // 6. Detect available providers and call ADE
    const availableProviders = getAvailableProviders();

    // Build humanContext and constraints based on frontend fields
    let humanContext: { emotionalState?: { mood?: string }; environmentalContext?: { weather?: string }; preferences?: { tone?: string } } | undefined;
    let constraints: { maxCostPer1kTokens?: number } | undefined;

    const shouldSendHumanContext =
      chatReq.autoStrategy === "humanFactors" ||
      chatReq.tone ||
      chatReq.mood ||
      chatReq.weather;

    if (shouldSendHumanContext && chatReq.autoStrategy !== "taskBased") {
      humanContext = {};
      if (chatReq.mood) {
        humanContext.emotionalState = { mood: chatReq.mood };
      }
      if (chatReq.weather) {
        humanContext.environmentalContext = { weather: chatReq.weather };
      }
      if (chatReq.tone) {
        humanContext.preferences = { tone: chatReq.tone };
      }
    }

    if (chatReq.autoStrategy === "costEfficient") {
      constraints = { maxCostPer1kTokens: 0.005 };
    }

    const { response: adeResponse, latencyMs: adeLatencyMs } = await callADE({
      prompt: chatReq.message,
      modality: chatReq.modality ?? "text",
      userTier: chatReq.userTier ?? "free",
      availableProviders,
      context: {
        conversationId,
        previousModelUsed,
      },
      humanContext,
      constraints,
      tone: chatReq.tone,
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

    // 9. Generate messageId in memory — no DB insert yet
    const messageId = randomUUID();

    // 10. Resolve web search decision (user preference + ADE analysis)
    const { shouldUseWebSearch, webSearchAutoDetected } = resolveWebSearch(
      chatReq.webSearch,
      adeResponse.analysis
    );

    // 11. Send routing event (messageId is known, but not persisted)
    await sendSSE(writer, encoder, {
      type: "routing",
      data: {
        conversationId,
        subConversationId: subConversationId ?? null,
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
        providerHint: adeResponse.providerHint ?? null,
        webSearchUsed: shouldUseWebSearch,
        webSearchAutoDetected,
      },
    });

    // 12. Stream from provider
    const systemPrompt = buildSystemPrompt();
    const enableWebSearch = shouldUseWebSearch;
    const enableThinking = shouldEnableThinking(adeResponse.analysis);

    const apiCallLogs: ApiCallLogEntry[] = [];

    const streamResult = await streamFromProvider(
      model,
      systemPrompt,
      history,
      enableWebSearch,
      enableThinking,
      writer,
      encoder,
      apiCallLogs
    );

    // 12. If primary failed, try backup
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
          apiCallLogs
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
          apiCallLogs,
          writer,
          encoder,
          subConversationId
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
        apiCallLogs,
        writer,
        encoder,
        subConversationId
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
  citations: Array<{ url: string; title: string; snippet?: string }>;
  usage: TokenUsage;
  latencyMs: number;
  webSearchUsed: boolean;
  error?: string;
}

interface ApiCallLogEntry {
  provider: string;
  modelId: string;
  statusCode: number;
  latencyMs: number;
  errorMessage?: string;
}

async function streamFromProvider(
  model: ModelInfo,
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  enableWebSearch: boolean,
  enableThinking: boolean,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  apiCallLogs: ApiCallLogEntry[]
): Promise<StreamResult> {
  const start = Date.now();
  let content = "";
  let thinkingContent = "";
  const citations: Array<{ url: string; title: string; snippet?: string }> = [];
  let usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
  };
  let webSearchUsed = false;

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
              data: {
                sources: event.citations.map((c) => ({
                  url: c.url,
                  title: c.title,
                  snippet: c.snippet ?? "",
                })),
              },
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
          if (event.webSearchUsed) {
            webSearchUsed = true;
          }
          break;
        case "error":
          throw new Error(event.error ?? "Provider stream error");
      }
    }

    const latencyMs = Date.now() - start;

    apiCallLogs.push({
      provider: model.provider,
      modelId: model.id,
      statusCode: 200,
      latencyMs,
    });

    return {
      success: true,
      content,
      thinkingContent,
      citations,
      usage,
      latencyMs,
      webSearchUsed,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const errorMessage = err instanceof Error ? err.message : "Unknown provider error";

    apiCallLogs.push({
      provider: model.provider,
      modelId: model.id,
      statusCode: 500,
      latencyMs,
      errorMessage,
    });

    return {
      success: false,
      content,
      thinkingContent,
      citations,
      usage,
      latencyMs,
      webSearchUsed,
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
  adeResponse: ADEResponse,
  adeLatencyMs: number,
  apiCallLogs: ApiCallLogEntry[],
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  subConversationId?: string
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
    webSearchUsed: result.webSearchUsed,
  };

  const extendedData: Record<string, unknown> = {};
  if (result.thinkingContent) {
    extendedData.thinkingContent = result.thinkingContent;
  }
  if (result.citations.length > 0) {
    extendedData.citations = result.citations;
  }

  // Insert assistant message only now that we have content
  await insertAssistantMessage(messageId, conversationId, {
    content: result.content,
    modelUsed,
    usage: result.usage,
    costUsd,
    latencyMs: result.latencyMs,
    adeLatencyMs,
    extendedData,
    subConversationId,
  });

  // Save routing log and API call logs now that message exists
  await saveRoutingLog(messageId, adeResponse, adeLatencyMs);

  for (const log of apiCallLogs) {
    await saveApiCallLog(
      messageId,
      log.provider,
      log.modelId,
      log.statusCode,
      log.latencyMs,
      log.errorMessage
    );
  }

  await updateConversationTimestamp(conversationId);

  await sendSSE(writer, encoder, {
    type: "done",
    data: {
      messageId,
      conversationId,
      subConversationId: subConversationId ?? null,
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
