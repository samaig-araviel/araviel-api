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
  getProjectInstructionsForConversation,
  resolveWebSearch,
  shouldEnableThinking,
  findSupportedBackup,
  validateSubConversation,
  fetchImportedConversationHistory,
  isImageGenerationModel,
  canModelGenerateImages,
  getImageCapableModels,
} from "@/lib/chat-helpers";
import { generateImage } from "@/lib/providers/image";
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
        chatReq.message,
        chatReq.projectId
      );
    }

    // 3. Save user message
    await saveUserMessage(conversationId, chatReq.message, subConversationId);

    // 4. Fetch conversation history (sub-conversation history includes highlighted text context)
    let history = await fetchConversationHistory(conversationId, subConversationId);

    // 4b. If an imported conversation ID is provided, prepend those messages
    if (chatReq.importedConversationId) {
      try {
        const importedMessages = await fetchImportedConversationHistory(
          chatReq.importedConversationId
        );

        if (importedMessages.length > 0) {
          const MAX_TOTAL_MESSAGES = 40;
          const nativeCount = history.length;
          const availableSlots = Math.max(0, MAX_TOTAL_MESSAGES - nativeCount);
          // Truncate imported messages from the front (oldest first) if over cap
          const trimmedImported =
            importedMessages.length > availableSlots
              ? importedMessages.slice(importedMessages.length - availableSlots)
              : importedMessages;

          history = [...trimmedImported, ...history];
        }
      } catch (err) {
        const statusCode = (err as Error & { statusCode?: number }).statusCode;
        if (statusCode === 404) {
          await sendSSE(writer, encoder, {
            type: "error",
            data: {
              message: "Imported conversation not found",
              code: "NOT_FOUND",
            },
          });
          await writer.close();
          return;
        }
        throw err;
      }
    }

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
      conversationHasImages: chatReq.conversationHasImages,
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

    // 12. Fetch project instructions for system prompt
    const projectInstructions = await getProjectInstructionsForConversation(conversationId);

    // 13. Determine if image generation is needed
    const enableImageGeneration =
      adeResponse.analysis.intent === "image_generation" || chatReq.modality === "image";

    const systemPrompt = buildSystemPrompt(projectInstructions ?? undefined);
    const enableWebSearch = shouldUseWebSearch;
    const enableThinking = shouldEnableThinking(adeResponse.analysis);

    const apiCallLogs: ApiCallLogEntry[] = [];

    // Path A: Dedicated image models (dall-e-3, imagen-4, stable-diffusion-3.5)
    if (enableImageGeneration && isImageGenerationModel(model.id)) {
      const start = Date.now();
      try {
        const imageResult = await generateImage(model.provider, model.id, chatReq.message);
        const latencyMs = Date.now() - start;

        apiCallLogs.push({
          provider: model.provider,
          modelId: model.id,
          statusCode: 200,
          latencyMs,
        });

        await sendSSE(writer, encoder, {
          type: "image_generation",
          data: {
            url: imageResult.url,
            prompt: chatReq.message,
            model: model.name,
            provider: model.provider,
            size: imageResult.size ?? "1024x1024",
            style: imageResult.style ?? null,
          },
        });

        const markdownContent = `![Generated image](${imageResult.url})`;
        await sendSSE(writer, encoder, {
          type: "delta",
          data: { content: markdownContent },
        });

        const imageStreamResult: StreamResult = {
          success: true,
          content: markdownContent,
          thinkingContent: "",
          citations: [],
          usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
          latencyMs,
          webSearchUsed: false,
        };

        await finalize(
          messageId,
          conversationId,
          imageStreamResult,
          model,
          backupModels,
          adeResponse,
          adeLatencyMs,
          apiCallLogs,
          writer,
          encoder,
          subConversationId
        );
        return;
      } catch (err) {
        const latencyMs = Date.now() - start;
        const errorMessage = err instanceof Error ? err.message : "Image generation failed";

        apiCallLogs.push({
          provider: model.provider,
          modelId: model.id,
          statusCode: 500,
          latencyMs,
          errorMessage,
        });

        // Try backup dedicated image model
        const backup = findSupportedBackup(backupModels);
        if (backup && isImageGenerationModel(backup.id)) {
          await sendSSE(writer, encoder, {
            type: "error",
            data: {
              message: `Retrying with backup model ${backup.name}...`,
              code: "PROVIDER_RETRY",
            },
          });

          const backupStart = Date.now();
          try {
            const backupImageResult = await generateImage(backup.provider, backup.id, chatReq.message);
            const backupLatencyMs = Date.now() - backupStart;

            apiCallLogs.push({
              provider: backup.provider,
              modelId: backup.id,
              statusCode: 200,
              latencyMs: backupLatencyMs,
            });

            await sendSSE(writer, encoder, {
              type: "image_generation",
              data: {
                url: backupImageResult.url,
                prompt: chatReq.message,
                model: backup.name,
                provider: backup.provider,
                size: backupImageResult.size ?? "1024x1024",
                style: backupImageResult.style ?? null,
              },
            });

            const markdownContent = `![Generated image](${backupImageResult.url})`;
            await sendSSE(writer, encoder, {
              type: "delta",
              data: { content: markdownContent },
            });

            const backupStreamResult: StreamResult = {
              success: true,
              content: markdownContent,
              thinkingContent: "",
              citations: [],
              usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
              latencyMs: backupLatencyMs,
              webSearchUsed: false,
            };

            await finalize(
              messageId,
              conversationId,
              backupStreamResult,
              backup,
              backupModels,
              adeResponse,
              adeLatencyMs,
              apiCallLogs,
              writer,
              encoder,
              subConversationId
            );
            return;
          } catch (backupErr) {
            const backupLatencyMs = Date.now() - backupStart;
            apiCallLogs.push({
              provider: backup.provider,
              modelId: backup.id,
              statusCode: 500,
              latencyMs: backupLatencyMs,
              errorMessage: backupErr instanceof Error ? backupErr.message : "Backup image gen failed",
            });
          }
        }

        await sendSSE(writer, encoder, {
          type: "error",
          data: {
            message: `Image generation failed: ${errorMessage}`,
            code: "PROVIDER_ERROR",
          },
        });
        await writer.close();
        return;
      }
    }

    // Guard: If image generation is needed but the model can't do it,
    // try to auto-fallback to an image-capable backup, or return a helpful response.
    if (enableImageGeneration && !canModelGenerateImages(model.id, model.provider)) {
      // Try to find an image-capable backup model
      const imageBackup = backupModels.find(
        (b) => SUPPORTED_PROVIDERS.has(b.provider) && canModelGenerateImages(b.id, b.provider)
      );

      if (imageBackup) {
        // Auto-fallback to image-capable backup
        await sendSSE(writer, encoder, {
          type: "error",
          data: {
            message: `${model.name} cannot generate images. Switching to ${imageBackup.name}...`,
            code: "PROVIDER_RETRY",
          },
        });

        if (isImageGenerationModel(imageBackup.id)) {
          // Backup is a dedicated image model — use image generation API
          const start = Date.now();
          try {
            const imageResult = await generateImage(imageBackup.provider, imageBackup.id, chatReq.message);
            const latencyMs = Date.now() - start;

            apiCallLogs.push({
              provider: imageBackup.provider,
              modelId: imageBackup.id,
              statusCode: 200,
              latencyMs,
            });

            await sendSSE(writer, encoder, {
              type: "image_generation",
              data: {
                url: imageResult.url,
                prompt: chatReq.message,
                model: imageBackup.name,
                provider: imageBackup.provider,
                size: imageResult.size ?? "1024x1024",
                style: imageResult.style ?? null,
              },
            });

            const markdownContent = `![Generated image](${imageResult.url})`;
            await sendSSE(writer, encoder, {
              type: "delta",
              data: { content: markdownContent },
            });

            const imageStreamResult: StreamResult = {
              success: true,
              content: markdownContent,
              thinkingContent: "",
              citations: [],
              usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
              latencyMs,
              webSearchUsed: false,
            };

            await finalize(
              messageId,
              conversationId,
              imageStreamResult,
              imageBackup,
              backupModels,
              adeResponse,
              adeLatencyMs,
              apiCallLogs,
              writer,
              encoder,
              subConversationId
            );
            return;
          } catch (err) {
            const latencyMs = Date.now() - start;
            apiCallLogs.push({
              provider: imageBackup.provider,
              modelId: imageBackup.id,
              statusCode: 500,
              latencyMs,
              errorMessage: err instanceof Error ? err.message : "Image generation failed",
            });
            // Fall through to the helpful message below
          }
        } else {
          // Backup is a chat model with native image gen — use streaming path
          const backupResult = await streamFromProvider(
            imageBackup,
            systemPrompt,
            history,
            enableWebSearch,
            enableThinking,
            true, // enableImageGeneration
            chatReq.message,
            writer,
            encoder,
            apiCallLogs
          );

          if (backupResult.success) {
            await finalize(
              messageId,
              conversationId,
              backupResult,
              imageBackup,
              backupModels,
              adeResponse,
              adeLatencyMs,
              apiCallLogs,
              writer,
              encoder,
              subConversationId
            );
            return;
          }
          // Fall through to the helpful message below
        }
      }

      // No image-capable backup found, or backup also failed — send helpful response
      const imageModels = getImageCapableModels();
      const suggestedPlatforms = adeResponse.fallback?.suggestedPlatforms ?? [];

      let helpContent = `### Unable to Generate Images\n\n`;
      helpContent += `**${model.name}** is a text-only model and cannot create images. `;
      helpContent += `To generate images, please select one of the image-capable models below.\n\n`;

      helpContent += `---\n\n`;
      helpContent += `#### Dedicated Image Models\n`;
      helpContent += `These models are purpose-built for image generation:\n\n`;
      for (const m of imageModels.dedicated) {
        helpContent += `- **${m.name}** *(${m.provider})* — \`${m.id}\`\n`;
      }

      helpContent += `\n#### Chat Models with Image Generation\n`;
      helpContent += `These models can generate images alongside text responses:\n\n`;
      for (const m of imageModels.nativeChat) {
        helpContent += `- **${m.name}** *(${m.provider})* — \`${m.id}\`\n`;
      }

      if (suggestedPlatforms.length > 0) {
        helpContent += `\n---\n\n`;
        helpContent += `#### External Platforms\n`;
        helpContent += `You can also try these dedicated image generation platforms:\n\n`;
        for (const platform of suggestedPlatforms) {
          helpContent += `- ${platform}\n`;
        }
      }

      helpContent += `\n---\n\n`;
      helpContent += `*Select an image-capable model from the model picker and try again.*`;

      await sendSSE(writer, encoder, {
        type: "delta",
        data: { content: helpContent },
      });

      const helpStreamResult: StreamResult = {
        success: true,
        content: helpContent,
        thinkingContent: "",
        citations: [],
        usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
        latencyMs: 0,
        webSearchUsed: false,
      };

      await finalize(
        messageId,
        conversationId,
        helpStreamResult,
        model,
        backupModels,
        adeResponse,
        adeLatencyMs,
        apiCallLogs,
        writer,
        encoder,
        subConversationId
      );
      return;
    }

    // Path B: Chat models (with optional native image gen)
    const streamResult = await streamFromProvider(
      model,
      systemPrompt,
      history,
      enableWebSearch,
      enableThinking,
      enableImageGeneration,
      chatReq.message,
      writer,
      encoder,
      apiCallLogs
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
          enableImageGeneration,
          chatReq.message,
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
  enableImageGeneration: boolean,
  userPrompt: string,
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
      enableImageGeneration,
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
        case "image_generation":
          if (event.imageUrl) {
            await sendSSE(writer, encoder, {
              type: "image_generation",
              data: {
                url: event.imageUrl,
                prompt: userPrompt,
                model: model.name,
                provider: model.provider,
              },
            });
            content += `\n![Generated image](${event.imageUrl})\n`;
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
