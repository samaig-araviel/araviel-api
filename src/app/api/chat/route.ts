import { NextRequest, NextResponse } from "next/server";
import { callADE } from "@/lib/ade";
import { calculateCost } from "@/lib/cost";
import { getProvider, getAvailableProviders } from "@/lib/providers";
import { createSSEStream, sendSSE } from "@/lib/stream/normalizer";
import { extractAravielMeta, containsPartialMeta } from "@/lib/stream/meta-parser";
import type { AravielMeta } from "@/lib/stream/meta-parser";
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
  getUserSettingsForChat,
  detectFileIntent,
  getProjectInstructionsForConversation,
  resolveWebSearch,
  shouldEnableThinking,
  findSupportedBackup,
  validateSubConversation,
  fetchImportedConversationHistory,
  isImageGenerationModel,
  canModelGenerateImages,
  getImageCapableModels,
  getDeepResearchInstructions,
} from "@/lib/chat-helpers";
import { generateImage } from "@/lib/providers/image";
import { uploadImageToStorage, saveImageMetadata } from "@/lib/image-storage";
import { canGenerate, chargeCredits } from "@/lib/credits";
import { getUserSubscription, checkAndConsumeTextCredit } from "@/lib/subscription";
import type { TextCreditState } from "@/lib/subscription";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../cors";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function POST(request: NextRequest) {
  let user: AuthenticatedUser;
  try {
    user = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: corsHeaders() });
    }
    throw err;
  }

  const { stream, writer, encoder } = createSSEStream();

  const response = new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });

  handleChat(request, writer, encoder, user).catch(async (err) => {
    const rawMessage = err instanceof Error ? err.message : "Unknown error";
    console.error("[chat] Unhandled error in handleChat:", rawMessage, err instanceof Error ? err.stack : "");

    const errorEvent: StreamEvent = {
      type: "error",
      data: {
        message: "Something unexpected happened. Please try again.",
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
  encoder: TextEncoder,
  user: AuthenticatedUser
): Promise<void> {
  try {
    // 1. Parse and validate
    const body = await request.json();
    const chatReq = validateChatRequest(body);

    // 1b. Guest/anonymous credit handling
    let serverTier = "free";
    let creditResult: TextCreditState | null = null;

    if (user.isAnonymous) {
      // Server-side guest limit: count user's messages across their conversations
      const { getSupabase: getSb } = await import("@/lib/supabase");
      const sb = getSb();
      const { data: convos } = await sb
        .from("conversations")
        .select("id")
        .eq("user_id", user.id);
      const convoIds = (convos ?? []).map((c: { id: string }) => c.id);

      let guestMessageCount = 0;
      if (convoIds.length > 0) {
        const { count } = await sb
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("role", "user")
          .in("conversation_id", convoIds);
        guestMessageCount = count ?? 0;
      }

      const GUEST_MESSAGE_LIMIT = 3;
      if (guestMessageCount >= GUEST_MESSAGE_LIMIT) {
        await sendSSE(writer, encoder, {
          type: "error",
          data: {
            message: "Sign up free to keep chatting. No card required.",
            code: "GUEST_LIMIT",
          },
        });
        await writer.close();
        return;
      }
      // Guest within limit — skip text credit system, proceed to chat
    } else {
      // 1c. Signed-in user: subscription + text credit check (monthly + 3-hour window)
      const subscription = await getUserSubscription(user.id);
      serverTier = subscription?.tier ?? "free";

      creditResult = await checkAndConsumeTextCredit(
        user.id,
        serverTier,
        subscription?.firstMonth ?? false
      );

      if (!creditResult.allowed) {
        const isMonthly = creditResult.reason === "monthly_exhausted";
        await sendSSE(writer, encoder, {
          type: "error",
          data: {
            message: isMonthly
              ? "You've used all your monthly credits. Upgrade for more."
              : "You've reached your 3-hour limit. Take a break or upgrade.",
            code: isMonthly ? "MONTHLY_CREDITS_EXHAUSTED" : "WINDOW_CREDITS_EXHAUSTED",
            tier: serverTier,
            monthlyUsed: creditResult.monthlyUsed,
            monthlyLimit: creditResult.monthlyLimit,
            windowUsed: creditResult.windowUsed,
            windowLimit: creditResult.windowLimit,
            windowResetAt: creditResult.windowResetAt,
          },
        });
        await writer.close();
        return;
      }
    }

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
        chatReq.projectId,
        user.id
      );
    }

    // 3. Save user message first (must complete before fetching history)
    await saveUserMessage(conversationId, chatReq.message, subConversationId);

    // 4-5. Fetch history and previous model in parallel (both are reads)
    const [fetchedHistory, previousModelUsed] = await Promise.all([
      fetchConversationHistory(conversationId, subConversationId),
      getPreviousModelId(conversationId).catch((err) => {
        console.warn("[chat] getPreviousModelId failed (non-critical):", err instanceof Error ? err.message : err);
        return undefined;
      }),
    ]);

    let history = fetchedHistory;

    // 4b. If an imported conversation ID is provided, prepend those messages
    if (chatReq.importedConversationId) {
      try {
        const importedMessages = await fetchImportedConversationHistory(
          chatReq.importedConversationId,
          user.id
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

    // 6. Detect available providers and call ADE
    const availableProviders = getAvailableProviders();

    // Map frontend autoStrategy to ADE routing strategy
    const STRATEGY_MAP: Record<string, string> = {
      default: "auto",
      taskBased: "balanced",
      humanFactors: "quality",
    };

    const strategy = STRATEGY_MAP[chatReq.autoStrategy ?? "default"] ?? "auto";

    // Build humanContext when mood/tone/weather are available
    let humanContext: { emotionalState?: { mood?: string }; environmentalContext?: { weather?: string }; preferences?: { tone?: string } } | undefined;

    if (chatReq.mood || chatReq.weather || chatReq.tone) {
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

    const { response: adeResponse, latencyMs: adeLatencyMs } = await callADE({
      prompt: chatReq.message,
      modality: chatReq.modality ?? "text",
      userTier: serverTier,
      availableProviders,
      context: {
        conversationId,
        previousModelUsed,
      },
      humanContext,
      tone: chatReq.tone,
      conversationHasImages: chatReq.conversationHasImages,
      strategy,
    });

    // 7. Check for fallback (unsupported task)
    if (adeResponse.fallback && adeResponse.fallback.supported === false) {
      // ADE couldn't find a model — fall through to send the fallback message
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

    // 12. Fetch project instructions and user settings for system prompt (in parallel)
    const [projectInstructions, userSettings] = await Promise.all([
      getProjectInstructionsForConversation(conversationId),
      getUserSettingsForChat(user.id),
    ]);

    // 13. Determine if image generation is needed
    const enableImageGeneration =
      adeResponse.analysis.intent === "image_generation" || chatReq.modality === "image";

    // 13b. Credit check for image generation
    const imageQuality = chatReq.imageQuality ?? "standard";
    if (enableImageGeneration && user.id) {
      const creditCheck = await canGenerate(user.id, imageQuality);
      if (!creditCheck.allowed) {
        await sendSSE(writer, encoder, {
          type: "error",
          data: {
            message: creditCheck.reason ?? "Insufficient image credits",
            code: "INSUFFICIENT_CREDITS",
            creditsRequired: creditCheck.cost,
            creditsAvailable: creditCheck.balance,
          },
        });
        await writer.close();
        return;
      }
    }

    const includeFileInstructions = detectFileIntent(chatReq.message);
    let systemPrompt = buildSystemPrompt(projectInstructions ?? undefined, { includeFileInstructions, userSettings });

    // Append deep research instructions when using a deep research model
    if (model.id === "o3-deep-research" || model.id === "o4-mini-deep-research") {
      systemPrompt += getDeepResearchInstructions();
    }

    const enableWebSearch = shouldUseWebSearch;
    const enableThinking = shouldEnableThinking(adeResponse.analysis);

    const apiCallLogs: ApiCallLogEntry[] = [];
    const pendingImages: PendingImageMeta[] = [];
    const creditInfo = {
      userId: user.id,
      imageQuality: imageQuality,
      wasImageGeneration: enableImageGeneration,
      textCredits: creditResult ?? undefined,
    };

    // Path A: Dedicated image models (dall-e-3, imagen-4, stable-diffusion-3.5)
    if (enableImageGeneration && isImageGenerationModel(model.id)) {
      const start = Date.now();
      try {
        const imageResult = await generateImage(model.provider, model.id, chatReq.message, imageQuality as import("@/lib/providers/image").ImageQuality);
        const latencyMs = Date.now() - start;

        apiCallLogs.push({
          provider: model.provider,
          modelId: model.id,
          statusCode: 200,
          latencyMs,
        });

        // Upload to Supabase Storage and get a persistent public URL
        let imageUrl = imageResult.url;
        let imageId: string | undefined;
        try {
          const stored = await uploadImageToStorage({
            imageDataUrl: imageResult.url,
            conversationId,
          });
          imageUrl = stored.publicUrl;
          imageId = stored.id;
          pendingImages.push({
            id: stored.id, storagePath: stored.storagePath, publicUrl: stored.publicUrl,
            prompt: chatReq.message, model: model.name, provider: model.provider,
            size: imageResult.size, style: imageResult.style,
          });
        } catch (uploadErr) {
          console.error("[chat] Image storage upload failed:", uploadErr instanceof Error ? uploadErr.message : uploadErr);
        }

        await sendSSE(writer, encoder, {
          type: "image_generation",
          data: {
            url: imageUrl,
            prompt: chatReq.message,
            model: model.name,
            provider: model.provider,
            size: imageResult.size ?? "1024x1024",
            style: imageResult.style ?? null,
            quality: imageQuality,
            id: imageId,
          },
        });

        // Store reference in content for database persistence (not sent as delta to avoid duplicate rendering)
        const markdownContent = `![Generated image: ${chatReq.message.slice(0, 100)}](${imageUrl})`;

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
          subConversationId,
          pendingImages,
          creditInfo
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
              fromModel: model.name,
              toModel: backup.name,
              reason: "Image generation failed, retrying with backup",
            },
          });

          const backupStart = Date.now();
          try {
            const backupImageResult = await generateImage(backup.provider, backup.id, chatReq.message, imageQuality as import("@/lib/providers/image").ImageQuality);
            const backupLatencyMs = Date.now() - backupStart;

            apiCallLogs.push({
              provider: backup.provider,
              modelId: backup.id,
              statusCode: 200,
              latencyMs: backupLatencyMs,
            });

            // Upload to Supabase Storage
            let backupImageUrl = backupImageResult.url;
            let backupImageId: string | undefined;
            try {
              const stored = await uploadImageToStorage({
                imageDataUrl: backupImageResult.url,
                conversationId,
              });
              backupImageUrl = stored.publicUrl;
              backupImageId = stored.id;
              pendingImages.push({
                id: stored.id, storagePath: stored.storagePath, publicUrl: stored.publicUrl,
                prompt: chatReq.message, model: backup.name, provider: backup.provider,
                size: backupImageResult.size, style: backupImageResult.style,
              });
            } catch (uploadErr) {
              console.error("[chat] Backup image storage upload failed:", uploadErr instanceof Error ? uploadErr.message : uploadErr);
            }

            await sendSSE(writer, encoder, {
              type: "image_generation",
              data: {
                url: backupImageUrl,
                prompt: chatReq.message,
                model: backup.name,
                provider: backup.provider,
                size: backupImageResult.size ?? "1024x1024",
                style: backupImageResult.style ?? null,
                quality: imageQuality,
                id: backupImageId,
              },
            });

            // Store reference in content for database persistence (not sent as delta to avoid duplicate rendering)
            const markdownContent = `![Generated image: ${chatReq.message.slice(0, 100)}](${backupImageUrl})`;

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
              subConversationId,
              pendingImages,
              creditInfo
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
    if (enableImageGeneration && !canModelGenerateImages(model.id)) {
      // Try to find an image-capable backup model
      const imageBackup = backupModels.find(
        (b) => SUPPORTED_PROVIDERS.has(b.provider) && canModelGenerateImages(b.id)
      );

      if (imageBackup) {
        // Auto-fallback to image-capable backup
        await sendSSE(writer, encoder, {
          type: "error",
          data: {
            message: `${model.name} cannot generate images. Switching to ${imageBackup.name}...`,
            code: "PROVIDER_RETRY",
            fromModel: model.name,
            toModel: imageBackup.name,
            reason: "This model doesn't support image generation",
          },
        });

        if (isImageGenerationModel(imageBackup.id)) {
          // Backup is a dedicated image model — use image generation API
          const start = Date.now();
          try {
            const imageResult = await generateImage(imageBackup.provider, imageBackup.id, chatReq.message, imageQuality as import("@/lib/providers/image").ImageQuality);
            const latencyMs = Date.now() - start;

            apiCallLogs.push({
              provider: imageBackup.provider,
              modelId: imageBackup.id,
              statusCode: 200,
              latencyMs,
            });

            // Upload to Supabase Storage
            let fbImageUrl = imageResult.url;
            let fbImageId: string | undefined;
            try {
              const stored = await uploadImageToStorage({
                imageDataUrl: imageResult.url,
                conversationId,
              });
              fbImageUrl = stored.publicUrl;
              fbImageId = stored.id;
              pendingImages.push({
                id: stored.id, storagePath: stored.storagePath, publicUrl: stored.publicUrl,
                prompt: chatReq.message, model: imageBackup.name, provider: imageBackup.provider,
                size: imageResult.size, style: imageResult.style,
              });
            } catch (uploadErr) {
              console.error("[chat] Fallback image storage upload failed:", uploadErr instanceof Error ? uploadErr.message : uploadErr);
            }

            await sendSSE(writer, encoder, {
              type: "image_generation",
              data: {
                url: fbImageUrl,
                prompt: chatReq.message,
                model: imageBackup.name,
                provider: imageBackup.provider,
                size: imageResult.size ?? "1024x1024",
                style: imageResult.style ?? null,
                quality: imageQuality,
                id: fbImageId,
              },
            });

            // Store reference in content for database persistence (not sent as delta to avoid duplicate rendering)
            const markdownContent = `![Generated image: ${chatReq.message.slice(0, 100)}](${fbImageUrl})`;

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
              subConversationId,
              pendingImages,
              creditInfo
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
            apiCallLogs,
            conversationId,
            messageId,
            pendingImages
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
              subConversationId,
              pendingImages,
              creditInfo
            );
            return;
          }
          // Fall through to the helpful message below
        }
      }

      // No image-capable backup in ADE alternates — auto-fallback to dedicated image model
      const dedicatedFallback = await tryDedicatedImageFallback(
        chatReq.message, model, apiCallLogs, writer, encoder, conversationId, messageId, pendingImages
      );
      if (dedicatedFallback) {
        await finalize(
          messageId, conversationId, dedicatedFallback,
          model, backupModels, adeResponse, adeLatencyMs,
          apiCallLogs, writer, encoder, subConversationId, pendingImages,
          creditInfo
        );
        return;
      }

      // Dedicated image model also failed — send helpful response
      const imageModels = getImageCapableModels();
      let helpContent = `### Unable to Generate Images\n\n`;
      helpContent += `**${model.name}** cannot create images and the fallback image model also failed. `;
      helpContent += `Please try again or select one of these image-capable models:\n\n`;
      for (const m of imageModels.dedicated) {
        helpContent += `- **${m.name}** *(${m.provider})*\n`;
      }

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
        messageId, conversationId, helpStreamResult,
        model, backupModels, adeResponse, adeLatencyMs,
        apiCallLogs, writer, encoder, subConversationId, pendingImages,
        creditInfo
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
      apiCallLogs,
      conversationId,
      messageId,
      pendingImages
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
            fromModel: model.name,
            toModel: backup.name,
            reason: "The primary model encountered an error",
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
          apiCallLogs,
          conversationId,
          messageId,
          pendingImages
        );

        if (!backupResult.success) {
          // If image generation was requested, try a dedicated image model as last resort
          if (enableImageGeneration) {
            const dedicatedFallback = await tryDedicatedImageFallback(
              chatReq.message, model, apiCallLogs, writer, encoder, conversationId, messageId, pendingImages
            );
            if (dedicatedFallback) {
              await finalize(
                messageId, conversationId, dedicatedFallback,
                model, backupModels, adeResponse, adeLatencyMs,
                apiCallLogs, writer, encoder, subConversationId, pendingImages,
                creditInfo
              );
              return;
            }
          }
          console.error(`[chat] All providers failed. Primary: ${model.id} (${model.provider}), Backup: ${backup.id} (${backup.provider}). Errors logged in apiCallLogs.`);
          await sendSSE(writer, encoder, {
            type: "error",
            data: {
              message: backupResult.error || "We're having trouble connecting to our AI providers. Please try again in a moment.",
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
          subConversationId,
          pendingImages,
          creditInfo
        );
      } else {
        // No backup model — if image gen was requested, try a dedicated image model
        if (enableImageGeneration) {
          const dedicatedFallback = await tryDedicatedImageFallback(
            chatReq.message, model, apiCallLogs, writer, encoder, conversationId, messageId, pendingImages
          );
          if (dedicatedFallback) {
            await finalize(
              messageId, conversationId, dedicatedFallback,
              model, backupModels, adeResponse, adeLatencyMs,
              apiCallLogs, writer, encoder, subConversationId, pendingImages,
              creditInfo
            );
            return;
          }
        }
        console.error(`[chat] Primary model failed with no backup available. Model: ${model.id} (${model.provider}), Error: ${streamResult.error}`);
        await sendSSE(writer, encoder, {
          type: "error",
          data: {
            message: streamResult.error || "We're having trouble connecting to our AI providers. Please try again in a moment.",
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
        subConversationId,
        pendingImages,
        creditInfo
      );
    }
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : "Internal server error";
    // Map known error patterns to user-friendly messages
    let userMessage = rawMessage;
    let code = "INTERNAL_ERROR";
    if (rawMessage.includes("ADE request failed") || rawMessage.includes("ADE request timed out")) {
      userMessage = "The routing engine is temporarily unavailable. Please try again.";
      code = "ADE_UNAVAILABLE";
    } else if (rawMessage.includes("Failed to create conversation") || rawMessage.includes("Failed to save user message")) {
      userMessage = "Unable to save your message. Please try again.";
      code = "DB_ERROR";
    }
    console.error(`[chat] Fatal error: ${rawMessage}`);
    try {
      await sendSSE(writer, encoder, {
        type: "error",
        data: { message: userMessage, code },
      });
    } catch {
      // Writer may already be closed
    }
    try {
      await writer.close();
    } catch {
      // Already closed
    }
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
  meta?: AravielMeta | null;
}

interface PendingImageMeta {
  id: string;
  storagePath: string;
  publicUrl: string;
  prompt: string;
  model: string;
  provider: string;
  size?: string;
  style?: string;
}

interface ApiCallLogEntry {
  provider: string;
  modelId: string;
  statusCode: number;
  latencyMs: number;
  errorMessage?: string;
}

/**
 * Ordered list of dedicated image models to try as last-resort fallback.
 * Each entry is tried in order; models whose provider API key is missing are skipped.
 */
const FALLBACK_IMAGE_MODELS = [
  { id: "gpt-image-1.5", name: "GPT Image 1.5", provider: "openai", envKey: "OPENAI_API_KEY" },
  { id: "dall-e-3", name: "DALL-E 3", provider: "openai", envKey: "OPENAI_API_KEY" },
  { id: "imagen-4", name: "Imagen 4", provider: "google", envKey: "GOOGLE_API_KEY" },
  { id: "stable-diffusion-3.5", name: "Stable Diffusion 3.5", provider: "stability", envKey: "STABILITY_API_KEY" },
];

/**
 * Last-resort fallback: try each dedicated image model in FALLBACK_IMAGE_MODELS
 * until one succeeds. Skips models whose API key is not configured.
 */
async function tryDedicatedImageFallback(
  prompt: string,
  originalModel: ModelInfo,
  apiCallLogs: ApiCallLogEntry[],
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  conversationId?: string,
  messageId?: string,
  pendingImages?: PendingImageMeta[]
): Promise<StreamResult | null> {
  for (const imgModel of FALLBACK_IMAGE_MODELS) {
    // Skip models whose API key is not configured
    if (!process.env[imgModel.envKey]) continue;

    // Skip the model that already failed as primary (avoid double-trying)
    if (imgModel.id === originalModel.id) continue;

    const start = Date.now();
    try {
      await sendSSE(writer, encoder, {
        type: "error",
        data: {
          message: `${originalModel.name} cannot generate images. Using ${imgModel.name} instead...`,
          code: "PROVIDER_RETRY",
          fromModel: originalModel.name,
          toModel: imgModel.name,
          reason: "This model doesn't support image generation",
        },
      });

      const imageResult = await generateImage(imgModel.provider, imgModel.id, prompt, "standard");
      const latencyMs = Date.now() - start;

      apiCallLogs.push({
        provider: imgModel.provider,
        modelId: imgModel.id,
        statusCode: 200,
        latencyMs,
      });

      // Upload to Supabase Storage
      let dlImageUrl = imageResult.url;
      let dlImageId: string | undefined;
      if (conversationId) {
        try {
          const stored = await uploadImageToStorage({
            imageDataUrl: imageResult.url,
            conversationId,
          });
          dlImageUrl = stored.publicUrl;
          dlImageId = stored.id;
          if (pendingImages) {
            pendingImages.push({
              id: stored.id, storagePath: stored.storagePath, publicUrl: stored.publicUrl,
              prompt, model: imgModel.name, provider: imgModel.provider,
              size: imageResult.size, style: imageResult.style,
            });
          }
        } catch (uploadErr) {
          console.error("[chat] Dedicated fallback image storage upload failed:", uploadErr instanceof Error ? uploadErr.message : uploadErr);
        }
      }

      await sendSSE(writer, encoder, {
        type: "image_generation",
        data: {
          url: dlImageUrl,
          prompt,
          model: imgModel.name,
          provider: imgModel.provider,
          size: imageResult.size ?? "1024x1024",
          style: imageResult.style ?? null,
          quality: "standard",
          id: dlImageId,
        },
      });

      const markdownContent = `![Generated image: ${prompt.slice(0, 100)}](${dlImageUrl})\n\n*${imgModel.name} — "${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}"*`;
      return {
        success: true,
        content: markdownContent,
        thinkingContent: "",
        citations: [],
        usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
        latencyMs,
        webSearchUsed: false,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      apiCallLogs.push({
        provider: imgModel.provider,
        modelId: imgModel.id,
        statusCode: 500,
        latencyMs,
        errorMessage: err instanceof Error ? err.message : "Dedicated image fallback failed",
      });
      // Continue to next fallback model
    }
  }

  return null;
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
  apiCallLogs: ApiCallLogEntry[],
  conversationId?: string,
  messageId?: string,
  pendingImages?: PendingImageMeta[]
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

    // Tail buffer to prevent <araviel_meta> block from flashing in the UI.
    // We hold back content once we detect a potential partial meta tag.
    let tailBuffer = "";
    const META_OPEN = "<araviel_meta>";

    async function flushSafeDelta(chunk: string): Promise<void> {
      tailBuffer += chunk;

      // Once we see the start of the meta block, hold everything from that point
      const metaIdx = tailBuffer.indexOf(META_OPEN);
      if (metaIdx !== -1) {
        // Flush everything before the meta tag, hold the rest
        const safe = tailBuffer.slice(0, metaIdx);
        tailBuffer = tailBuffer.slice(metaIdx);
        if (safe) {
          await sendSSE(writer, encoder, { type: "delta", data: { content: safe } });
        }
        return;
      }

      // Check if the tail might be a partial opening tag
      if (containsPartialMeta(tailBuffer)) {
        // Find the longest suffix that could be a partial match
        let holdFrom = tailBuffer.length;
        for (let i = 1; i <= META_OPEN.length && i <= tailBuffer.length; i++) {
          const suffix = tailBuffer.slice(-i);
          if (META_OPEN.startsWith(suffix)) {
            holdFrom = tailBuffer.length - i;
            break;
          }
        }
        const safe = tailBuffer.slice(0, holdFrom);
        tailBuffer = tailBuffer.slice(holdFrom);
        if (safe) {
          await sendSSE(writer, encoder, { type: "delta", data: { content: safe } });
        }
        return;
      }

      // No meta risk — flush everything
      const toSend = tailBuffer;
      tailBuffer = "";
      if (toSend) {
        await sendSSE(writer, encoder, { type: "delta", data: { content: toSend } });
      }
    }

    for await (const event of providerStream) {
      switch (event.type) {
        case "delta":
          if (event.content) {
            content += event.content;
            await flushSafeDelta(event.content);
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
            // Upload to Supabase Storage
            let nativeImageUrl = event.imageUrl;
            let nativeImageId: string | undefined;
            if (conversationId) {
              try {
                const stored = await uploadImageToStorage({
                  imageDataUrl: event.imageUrl,
                  conversationId,
                });
                nativeImageUrl = stored.publicUrl;
                nativeImageId = stored.id;
                if (pendingImages) {
                  pendingImages.push({
                    id: stored.id, storagePath: stored.storagePath, publicUrl: stored.publicUrl,
                    prompt: userPrompt, model: model.name, provider: model.provider,
                  });
                }
              } catch (uploadErr) {
                console.error("[chat] Native image storage upload failed:", uploadErr instanceof Error ? uploadErr.message : uploadErr);
              }
            }
            await sendSSE(writer, encoder, {
              type: "image_generation",
              data: {
                url: nativeImageUrl,
                prompt: userPrompt,
                model: model.name,
                provider: model.provider,
                id: nativeImageId,
              },
            });
            content += `\n![Generated image: ${userPrompt.slice(0, 100)}](${nativeImageUrl})\n`;
          }
          break;
        case "research_status":
          await sendSSE(writer, encoder, {
            type: "research_status",
            data: {
              status: event.researchStatus,
              sources: event.researchSources ?? 0,
              actions: event.researchActions ?? [],
            },
          });
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

    // If there's any remaining tail buffer that wasn't part of the meta block, flush it.
    // (This handles the case where the AI didn't produce a meta block at all.)
    const { cleanContent, meta } = extractAravielMeta(content);

    // Flush any buffered non-meta content that wasn't sent during streaming
    // The tailBuffer may contain the meta block or leftover content
    if (tailBuffer && !tailBuffer.includes(META_OPEN)) {
      await sendSSE(writer, encoder, { type: "delta", data: { content: tailBuffer } });
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
      content: cleanContent,
      thinkingContent,
      citations,
      usage,
      latencyMs,
      webSearchUsed,
      meta,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const rawError = err instanceof Error ? err.message : "Unknown provider error";

    // Log the raw error for debugging
    apiCallLogs.push({
      provider: model.provider,
      modelId: model.id,
      statusCode: 500,
      latencyMs,
      errorMessage: rawError,
    });

    // Return a sanitized, provider-agnostic error message to the user
    const userFacingError = sanitizeProviderError(rawError, model.provider);

    return {
      success: false,
      content,
      thinkingContent,
      citations,
      usage,
      latencyMs,
      webSearchUsed,
      error: userFacingError,
    };
  }
}

/**
 * Sanitize raw provider error messages to be user-friendly and provider-agnostic.
 * Raw API errors may reference specific provider names (e.g. "Anthropic API") even
 * when the user selected a different provider, because backup/fallback models may
 * come from different providers.
 */
function sanitizeProviderError(rawError: string, _provider: string): string {
  const lower = rawError.toLowerCase();

  // Credit / billing errors
  if (lower.includes("credit balance") || lower.includes("billing") || lower.includes("insufficient") || lower.includes("quota")) {
    return "A service billing issue occurred. Please try again later.";
  }

  // Rate limiting
  if (lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("429")) {
    return "The service is temporarily busy. Please try again in a moment.";
  }

  // Authentication errors
  if (lower.includes("unauthorized") || lower.includes("authentication") || lower.includes("api key") || lower.includes("401") || lower.includes("403")) {
    return "A service configuration issue occurred. Please try again later.";
  }

  // Model not found / unsupported
  if (lower.includes("not found") || lower.includes("does not exist") || lower.includes("unsupported model")) {
    return "The requested model is currently unavailable. Please try a different model.";
  }

  // Content policy / safety
  if (lower.includes("content policy") || lower.includes("safety") || lower.includes("blocked")) {
    return "Your request was blocked by the model's content policy. Please rephrase and try again.";
  }

  // Overloaded / server errors
  if (lower.includes("overloaded") || lower.includes("server error") || lower.includes("500") || lower.includes("503")) {
    return "The service is temporarily unavailable. Please try again.";
  }

  // Generic fallback — don't leak raw error details
  return "Something went wrong. Please try again.";
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
  subConversationId?: string,
  pendingImages?: PendingImageMeta[],
  creditInfo?: { userId?: string; imageQuality?: string; wasImageGeneration?: boolean; textCredits?: TextCreditState }
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
  if (result.meta?.followUps && result.meta.followUps.length > 0) {
    extendedData.followUps = result.meta.followUps;
  }
  if (result.meta?.questions && result.meta.questions.length > 0) {
    extendedData.questions = result.meta.questions;
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

  // Now that the message row exists, insert image metadata (FK on message_id is satisfied)
  if (pendingImages && pendingImages.length > 0) {
    for (const img of pendingImages) {
      await saveImageMetadata({
        ...img,
        userId: creditInfo?.userId || "",
        conversationId,
        messageId,
      });
    }
  }

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

  // Charge credits for image generation
  let creditChargeResult: { creditsCharged?: number; remainingBalance?: number } = {};
  if (creditInfo?.wasImageGeneration && creditInfo?.userId && pendingImages && pendingImages.length > 0) {
    try {
      const charge = await chargeCredits(creditInfo.userId, creditInfo.imageQuality ?? "standard", {
        modelUsed: model.id,
        provider: model.provider,
        conversationId,
        messageId,
        prompt: pendingImages[0]?.prompt,
      });
      creditChargeResult = {
        creditsCharged: charge.creditsCharged,
        remainingBalance: charge.remainingBalance,
      };
    } catch (err) {
      console.error("[chat] Credit charge failed:", err instanceof Error ? err.message : err);
    }
  }

  // Text credit was already consumed atomically in handleChat (checkAndConsumeTextCredit)

  // Send follow-ups and questions from parsed metadata before the done event
  if (result.meta) {
    if (result.meta.followUps.length > 0) {
      await sendSSE(writer, encoder, {
        type: "followups",
        data: { suggestions: result.meta.followUps },
      });
    }
    if (result.meta.questions.length > 0) {
      await sendSSE(writer, encoder, {
        type: "questions",
        data: { questions: result.meta.questions },
      });
    }
  }

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
      ...(creditChargeResult.creditsCharged !== undefined && {
        credits: {
          charged: creditChargeResult.creditsCharged,
          remaining: creditChargeResult.remainingBalance,
          quality: creditInfo?.imageQuality ?? "standard",
        },
      }),
      ...(creditInfo?.textCredits && {
        textCredits: {
          monthlyUsed: creditInfo.textCredits.monthlyUsed,
          monthlyLimit: creditInfo.textCredits.monthlyLimit,
          windowUsed: creditInfo.textCredits.windowUsed,
          windowLimit: creditInfo.textCredits.windowLimit,
          windowResetAt: creditInfo.textCredits.windowResetAt,
        },
      }),
    },
  });

  await writer.close();
}
