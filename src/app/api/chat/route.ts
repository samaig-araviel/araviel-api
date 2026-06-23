import { NextRequest, NextResponse } from "next/server";
import { callADE } from "@/lib/ade";
import { calculateCost } from "@/lib/cost";
import { getProvider, getAvailableProviders } from "@/lib/providers";
import { createSSEStream, sendSSE } from "@/lib/stream/normalizer";
import { extractAravielMeta, containsPartialMeta } from "@/lib/stream/meta-parser";
import type { AravielMeta } from "@/lib/stream/meta-parser";
import {
  extractAravielTitle,
  containsPartialTitle,
  findTitleClose,
  stripStrayTitleMarkers,
} from "@/lib/stream/title-parser";
import { updateConversationTitleIfUnchanged } from "@/lib/conversation-title-updater";
import { dedupeCitations } from "@/lib/citations";
import type { SupportedProvider, StreamEvent, SystemPromptParts, TokenUsage, ModelInfo, ADEResponse, ConversationMessage, ImageAttachment } from "@/lib/types";
import { SUPPORTED_PROVIDERS } from "@/lib/types";
import { randomUUID } from "crypto";
import {
  validateChatRequest,
  getOrCreateConversation,
  saveUserMessage,
  insertAssistantMessage,
  upsertPartialAssistantMessage,
  updateConversationTimestamp,
  saveRoutingLog,
  saveApiCallLog,
  fetchConversationHistory,
  getPreviousModelId,
  getPreviousAssistantWebSearchUsed,
  resolveModel,
  buildSystemPrompt,
  buildSystemPromptParts,
  getUserSettingsForChat,
  getLocationMetadataConsent,
  detectFileIntent,
  getProjectInstructionsForConversation,
  resolveWebSearch,
  resolveThinking,
  applyThinkingProviderOverride,
  findSupportedBackup,
  findThinkingAwareBackup,
  validateSubConversation,
  fetchImportedConversationHistory,
  isImageGenerationModel,
  canModelGenerateImages,
  getImageCapableModels,
  getDeepResearchInstructions,
  supportsVision,
} from "@/lib/chat-helpers";
import {
  OPENAI_DEEP_RESEARCH_MODELS,
  RESEARCH_MODE_LABELS,
} from "@/lib/thinking-models";
import { generateImage } from "@/lib/providers/image";
import { detectImageAspectRatio, type ImageAspectRatio } from "@/lib/image-aspect-ratio";
import { uploadImageToStorage, saveImageMetadata } from "@/lib/image-storage";
import { canGenerate, chargeCredits, getBalance } from "@/lib/credits";
import type { CreditBalance, ChargeResult } from "@/lib/credits";
import { getUserSubscription, checkAndConsumeTextCredit } from "@/lib/subscription";
import type { TextCreditState } from "@/lib/subscription";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../cors";
import { logger, type Logger } from "@/lib/logger";
import { coerceModelId, RetiredModelError } from "@/lib/retired-models";
import { requestContext } from "@/lib/request-context";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");

  let user: AuthenticatedUser;
  try {
    user = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status, headers: corsHeaders(origin) }
      );
    }
    throw err;
  }

  const { stream, writer, encoder } = createSSEStream();

  const response = new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(origin),
    },
  });

  handleChat(request, writer, encoder, user).catch(async (err) => {
    logger.error("Unhandled error in handleChat", err, {
      route: "chat",
      userId: user.id,
    });

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
  const ctx = requestContext(request, "chat");
  const log = ctx.log.child({ userId: user.id });
  try {
    // 1. Parse and validate
    const body = await request.json();
    const chatReq = validateChatRequest(body);

    // 1a. Coerce retired model IDs to their documented replacements. This is a
    // safety net for stale client preferences and historical API callers using
    // a model that the provider has since deprecated. Coerce hits are logged
    // for observability; an unrecoverable retirement (no replacement) sends a
    // clean SSE error and ends the stream.
    if (chatReq.selectedModelId) {
      try {
        chatReq.selectedModelId = coerceModelId(chatReq.selectedModelId, {
          route: "chat",
          userId: user.id,
        });
      } catch (err) {
        if (err instanceof RetiredModelError) {
          await sendSSE(writer, encoder, {
            type: "error",
            data: {
              message: `${err.retiredModelId} is no longer available from its provider. Please choose a different model.`,
              code: "MODEL_RETIRED",
            },
          });
          await writer.close();
          return;
        }
        throw err;
      }
    }

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
        .eq("user_id", user.id)
        .is("deleted_at", null);
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

    // Image-only requests have an empty `message`; derive non-empty fallbacks
    // for the conversation title and ADE routing prompt so downstream calls
    // that expect prompt text still work, while the saved message preserves
    // the user's original empty content alongside the image attachments.
    const messageIsEmpty = chatReq.message.length === 0;
    const hasUploadedImagesEarly = !!chatReq.images && chatReq.images.length > 0;
    const titleFallback = hasUploadedImagesEarly
      ? chatReq.images![0]?.fileName?.trim() || "Image upload"
      : "";
    const conversationTitleSource = messageIsEmpty ? titleFallback : chatReq.message;
    const routingPrompt = messageIsEmpty
      ? "Describe the attached image."
      : chatReq.message;

    // 2. Get or create conversation (for sub-conversations, validate and use the parent conversation)
    let conversationId: string;
    let isNewConversation = false;
    let placeholderTitle = "";
    const subConversationId = chatReq.subConversationId;

    if (subConversationId) {
      const subConv = await validateSubConversation(subConversationId);
      conversationId = subConv.conversationId;
    } else {
      const resolved = await getOrCreateConversation(
        chatReq.conversationId,
        conversationTitleSource,
        chatReq.projectId,
        user.id
      );
      conversationId = resolved.id;
      isNewConversation = resolved.isNew;
      placeholderTitle = resolved.placeholderTitle;
    }

    // 3. Save user message first (must complete before fetching history)
    await saveUserMessage(conversationId, chatReq.message, subConversationId, chatReq.images);

    // 4-5. Fetch history and previous model in parallel (both are reads)
    const [fetchedHistory, previousModelUsed] = await Promise.all([
      fetchConversationHistory(conversationId, subConversationId),
      getPreviousModelId(conversationId).catch((err) => {
        log.warn("getPreviousModelId failed (non-critical)", {}, err);
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

    // Build humanContext when mood/tone/weather are available.
    //
    // Weather is location-derived, so it sits behind the user's "Location
    // metadata" privacy toggle. The client gates this on its end, but we
    // re-check server-side as the authoritative consent boundary — a stale
    // or tampered client must never leak location-derived data to the model.
    let humanContext: { emotionalState?: { mood?: string }; environmentalContext?: { weather?: string }; preferences?: { tone?: string } } | undefined;

    if (chatReq.mood || chatReq.weather || chatReq.tone) {
      humanContext = {};
      if (chatReq.mood) {
        humanContext.emotionalState = { mood: chatReq.mood };
      }
      if (chatReq.weather) {
        const hasLocationConsent = await getLocationMetadataConsent(user.id);
        if (hasLocationConsent) {
          humanContext.environmentalContext = { weather: chatReq.weather };
        }
      }
      if (chatReq.tone) {
        humanContext.preferences = { tone: chatReq.tone };
      }
    }

    // Derive ADE modality: if user uploaded images and isn't in image-gen mode, use "text+image"
    const hasUploadedImages = chatReq.images && chatReq.images.length > 0;
    const adeModality = hasUploadedImages
      ? (chatReq.modality === "image" ? "image" : "text+image")
      : (chatReq.modality ?? "text");

    // Track whether conversation has user-uploaded images or AI-generated images
    const conversationHasImages = chatReq.conversationHasImages || hasUploadedImages || false;

    const { response: adeResponse, latencyMs: adeLatencyMs } = await callADE({
      prompt: routingPrompt,
      modality: adeModality,
      userTier: serverTier,
      availableProviders,
      context: {
        conversationId,
        previousModelUsed,
      },
      humanContext,
      tone: chatReq.tone,
      conversationHasImages: conversationHasImages || undefined,
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

    // Single canonical reasoning preference for this request. Both the
    // post-ADE override and the retry-side backup picker consume it, so
    // building it once keeps the two paths in lockstep.
    const thinkingPreference = {
      extendedThinking: chatReq.extendedThinking,
      deepResearch: chatReq.deepResearch,
      googleThinking: chatReq.googleThinking,
    };

    // If the user picked a reasoning mode in the dropdown, steer model
    // selection toward the matching provider. ADE chooses based on the prompt
    // alone, so without this step a research-y prompt + "Extended Thinking"
    // could still land on a non-Anthropic model.
    const overridden = applyThinkingProviderOverride(
      resolved,
      thinkingPreference,
      availableProviders
    );

    const { model, backupModels, isManualSelection } = overridden;

    // 9. Generate messageId in memory — no DB insert yet
    const messageId = randomUUID();

    // 10. Resolve web search decision: user preference, ADE analysis, a
    // prompt-level frontstop for real-time tells ADE may miss, and a
    // conversation-level inheritance so short follow-ups in an already-
    // live-data chat ("hourly table for Maidstone") keep the search on.
    // Skip the inheritance lookup for brand-new conversations — there's
    // nothing to inherit and the DB roundtrip would be wasted.
    const previousAssistantUsedSearch = isNewConversation
      ? false
      : await getPreviousAssistantWebSearchUsed(conversationId);
    const { shouldUseWebSearch, webSearchAutoDetected } = resolveWebSearch(
      chatReq.webSearch,
      adeResponse.analysis,
      chatReq.message,
      previousAssistantUsedSearch
    );

    // Decide whether the UI should reveal a "Thinking" timeline for this
    // request. Quick prompts don't deserve one — Claude/Perplexity hide it
    // unless deep reasoning is actually happening. Manual reasoning toggles
    // always show it; otherwise the panel only appears for ADE-classified
    // "demanding" prompts. The frontend keeps a safety net on the `thinking`
    // SSE event so an unexpected reasoning chunk still reveals the panel.
    const showThinking =
      chatReq.extendedThinking === true ||
      chatReq.deepResearch === true ||
      chatReq.googleThinking === true ||
      adeResponse.analysis.complexity === "demanding";

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
        showThinking,
      },
    });

    // 12. Fetch project instructions and user settings for system prompt (in parallel)
    const [projectInstructions, userSettings] = await Promise.all([
      getProjectInstructionsForConversation(conversationId),
      getUserSettingsForChat(user.id),
    ]);

    // 13. Determine if image generation is needed. An empty user message
    // can never be a generation prompt, so suppress the generation path even
    // if the intent classifier or modality flag tries to fire it.
    const enableImageGeneration =
      !messageIsEmpty &&
      (adeResponse.analysis.intent === "image_generation" || chatReq.modality === "image");

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

    const effectiveImagePrompt = chatReq.message;
    const imageAspectRatio = enableImageGeneration
      ? detectImageAspectRatio(chatReq.message)
      : undefined;

    const includeFileInstructions = detectFileIntent(chatReq.message);
    // Only ask the model to emit an <araviel_title> block when this is a
    // brand-new conversation with a real (non-sub) id. For text-mode chats on
    // chat-capable models that stream naturally — skip for dedicated image
    // generation since those models don't stream text.
    const includeTitleInstructions =
      isNewConversation &&
      !subConversationId &&
      chatReq.modality !== "image" &&
      adeResponse.analysis.intent !== "image_generation";
    let systemPrompt = buildSystemPrompt(projectInstructions ?? undefined, {
      includeFileInstructions,
      includeTitleInstructions,
      userSettings,
    });

    // Structured form of the same prompt for caching-aware providers
    // (Anthropic). Built from the same inputs as `systemPrompt`. Other
    // providers ignore this and continue to use `systemPrompt`.
    const systemPromptParts: SystemPromptParts = buildSystemPromptParts(
      projectInstructions ?? undefined,
      {
        includeFileInstructions,
        includeTitleInstructions,
        userSettings,
      }
    );

    // Append deep research instructions when using a deep research model.
    // Deep research models are OpenAI-only today, so this does not affect
    // `systemPromptParts` (which only feeds Anthropic). If Anthropic deep
    // research is added in the future, append to both here.
    if (OPENAI_DEEP_RESEARCH_MODELS.has(model.id)) {
      systemPrompt += getDeepResearchInstructions();
    }

    const enableWebSearch = shouldUseWebSearch;
    const enableThinking = resolveThinking(
      adeResponse.analysis,
      model.provider,
      thinkingPreference
    );

    const apiCallLogs: ApiCallLogEntry[] = [];
    const pendingImages: PendingImageMeta[] = [];
    const creditInfo: {
      userId: string;
      imageQuality: string;
      imageAspectRatio?: ImageAspectRatio;
      wasImageGeneration: boolean;
      textCredits?: TextCreditState;
      preChargedResult?: ChargeResult;
    } = {
      userId: user.id,
      imageQuality: imageQuality,
      imageAspectRatio: imageAspectRatio,
      wasImageGeneration: enableImageGeneration,
      textCredits: creditResult ?? undefined,
    };

    // Path A: Dedicated image models (gpt-image-1.5, imagen-4, stable-diffusion-3.5)
    if (enableImageGeneration && isImageGenerationModel(model.id)) {
      const start = Date.now();
      try {
        const imageResult = await generateImage(model.provider, model.id, effectiveImagePrompt, { quality: imageQuality as import("@/lib/providers/image").ImageQuality, aspectRatio: imageAspectRatio });
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
            prompt: effectiveImagePrompt, model: model.name, provider: model.provider,
            size: imageResult.size, style: imageResult.style,
          });
        } catch (uploadErr) {
          log.error("Image storage upload failed", uploadErr, { stage: "primary" });
        }

        // Charge credits after successful upload, before confirming the image to the client.
        // If the charge fails we abort — the user must not receive a free image.
        if (pendingImages.length > 0 && creditInfo.userId) {
          try {
            const chargeResult = await chargeCredits(creditInfo.userId, imageQuality, {
              modelUsed: model.id,
              provider: model.provider,
              conversationId,
              messageId,
              prompt: effectiveImagePrompt,
            });
            if (!chargeResult.charged) {
              await sendSSE(writer, encoder, { type: "error", data: { message: "Insufficient image credits", code: "INSUFFICIENT_CREDITS" } });
              await writer.close();
              return;
            }
            creditInfo.preChargedResult = chargeResult;
          } catch (chargeErr) {
            log.error("Image credit charge failed", chargeErr, { stage: "primary" });
            await sendSSE(writer, encoder, { type: "error", data: { message: "Failed to charge image credits. Please try again.", code: "CREDIT_CHARGE_FAILED" } });
            await writer.close();
            return;
          }
        }

        await sendSSE(writer, encoder, {
          type: "image_generation",
          data: {
            url: imageUrl,
            prompt: effectiveImagePrompt,
            model: model.name,
            provider: model.provider,
            size: imageResult.size ?? "1024x1024",
            style: imageResult.style ?? null,
            quality: imageQuality,
            id: imageId,
          },
        });

        // Store reference in content for database persistence (not sent as delta to avoid duplicate rendering)
        const markdownContent = `![Generated image: ${effectiveImagePrompt.slice(0, 100)}](${imageUrl})`;

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
              fromModelId: model.id,
              fromProvider: model.provider,
              toModel: backup.name,
              toModelId: backup.id,
              toProvider: backup.provider,
              toScore: backup.score,
              toReasoning: backup.reasoning,
              reason: "Image generation failed, retrying with backup",
            },
          });

          const backupStart = Date.now();
          try {
            const backupImageResult = await generateImage(backup.provider, backup.id, effectiveImagePrompt, { quality: imageQuality as import("@/lib/providers/image").ImageQuality, aspectRatio: imageAspectRatio });
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
                prompt: effectiveImagePrompt, model: backup.name, provider: backup.provider,
                size: backupImageResult.size, style: backupImageResult.style,
              });
            } catch (uploadErr) {
              log.error("Image storage upload failed", uploadErr, { stage: "backup" });
            }

            // Charge credits after successful upload, before confirming image to client.
            if (pendingImages.length > 0 && creditInfo.userId) {
              try {
                const chargeResult = await chargeCredits(creditInfo.userId, imageQuality, {
                  modelUsed: backup.id,
                  provider: backup.provider,
                  conversationId,
                  messageId,
                  prompt: effectiveImagePrompt,
                });
                if (!chargeResult.charged) {
                  await sendSSE(writer, encoder, { type: "error", data: { message: "Insufficient image credits", code: "INSUFFICIENT_CREDITS" } });
                  await writer.close();
                  return;
                }
                creditInfo.preChargedResult = chargeResult;
              } catch (chargeErr) {
                log.error("Image credit charge failed", chargeErr, { stage: "backup" });
                await sendSSE(writer, encoder, { type: "error", data: { message: "Failed to charge image credits. Please try again.", code: "CREDIT_CHARGE_FAILED" } });
                await writer.close();
                return;
              }
            }

            await sendSSE(writer, encoder, {
              type: "image_generation",
              data: {
                url: backupImageUrl,
                prompt: effectiveImagePrompt,
                model: backup.name,
                provider: backup.provider,
                size: backupImageResult.size ?? "1024x1024",
                style: backupImageResult.style ?? null,
                quality: imageQuality,
                id: backupImageId,
              },
            });

            // Store reference in content for database persistence (not sent as delta to avoid duplicate rendering)
            const markdownContent = `![Generated image: ${effectiveImagePrompt.slice(0, 100)}](${backupImageUrl})`;

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
            fromModelId: model.id,
            fromProvider: model.provider,
            toModel: imageBackup.name,
            toModelId: imageBackup.id,
            toProvider: imageBackup.provider,
            toScore: imageBackup.score,
            toReasoning: imageBackup.reasoning,
            reason: "This model doesn't support image generation",
          },
        });

        if (isImageGenerationModel(imageBackup.id)) {
          // Backup is a dedicated image model — use image generation API
          const start = Date.now();
          try {
            const imageResult = await generateImage(imageBackup.provider, imageBackup.id, effectiveImagePrompt, { quality: imageQuality as import("@/lib/providers/image").ImageQuality, aspectRatio: imageAspectRatio });
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
                prompt: effectiveImagePrompt, model: imageBackup.name, provider: imageBackup.provider,
                size: imageResult.size, style: imageResult.style,
              });
            } catch (uploadErr) {
              log.error("Image storage upload failed", uploadErr, { stage: "fallback" });
            }

            // Charge credits after successful upload, before confirming image to client.
            if (pendingImages.length > 0 && creditInfo.userId) {
              try {
                const chargeResult = await chargeCredits(creditInfo.userId, imageQuality, {
                  modelUsed: imageBackup.id,
                  provider: imageBackup.provider,
                  conversationId,
                  messageId,
                  prompt: effectiveImagePrompt,
                });
                if (!chargeResult.charged) {
                  await sendSSE(writer, encoder, { type: "error", data: { message: "Insufficient image credits", code: "INSUFFICIENT_CREDITS" } });
                  await writer.close();
                  return;
                }
                creditInfo.preChargedResult = chargeResult;
              } catch (chargeErr) {
                log.error("Image credit charge failed", chargeErr, { stage: "fallback" });
                await sendSSE(writer, encoder, { type: "error", data: { message: "Failed to charge image credits. Please try again.", code: "CREDIT_CHARGE_FAILED" } });
                await writer.close();
                return;
              }
            }

            await sendSSE(writer, encoder, {
              type: "image_generation",
              data: {
                url: fbImageUrl,
                prompt: effectiveImagePrompt,
                model: imageBackup.name,
                provider: imageBackup.provider,
                size: imageResult.size ?? "1024x1024",
                style: imageResult.style ?? null,
                quality: imageQuality,
                id: fbImageId,
              },
            });

            // Store reference in content for database persistence (not sent as delta to avoid duplicate rendering)
            const markdownContent = `![Generated image: ${effectiveImagePrompt.slice(0, 100)}](${fbImageUrl})`;

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
            effectiveImagePrompt,
            writer,
            encoder,
            apiCallLogs,
            conversationId,
            messageId,
            pendingImages,
            chatReq.images,
            undefined, // titleContext — image backup path doesn't generate titles
            systemPromptParts,
            log,
            imageQuality,
            imageAspectRatio,
            subConversationId
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
        effectiveImagePrompt, model, apiCallLogs, writer, encoder, conversationId, messageId, pendingImages, creditInfo
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
    // Only engage title interception when we asked the model to emit one.
    const titleContext: TitleContext | undefined = includeTitleInstructions
      ? {
          conversationId,
          placeholderTitle,
          requestId: ctx.requestId,
        }
      : undefined;

    const streamResult = await streamFromProvider(
      model,
      systemPrompt,
      history,
      enableWebSearch,
      enableThinking,
      enableImageGeneration,
      effectiveImagePrompt,
      writer,
      encoder,
      apiCallLogs,
      conversationId,
      messageId,
      pendingImages,
      chatReq.images,
      titleContext,
      systemPromptParts,
      log,
      imageQuality,
      imageAspectRatio,
      subConversationId
    );

    // 13. If primary failed, try backup
    if (!streamResult.success) {
      // Pick a backup that honors the user's reasoning toggle when possible.
      // Falls through to any supported backup with `modeHonored: false` if no
      // matching-provider thinking-capable model is available — the toggle is
      // then disclosed as off for this response rather than silently dropped.
      const backupChoice = findThinkingAwareBackup(
        backupModels,
        thinkingPreference,
        availableProviders
      );

      if (backupChoice) {
        const { backup, modeHonored, downgradedFrom } = backupChoice;
        const downgradeLabel =
          !modeHonored && downgradedFrom !== null
            ? RESEARCH_MODE_LABELS[downgradedFrom]
            : null;
        const retryMessage = downgradeLabel
          ? `Retrying with backup model ${backup.name}. ${downgradeLabel} is off for this response.`
          : `Retrying with backup model ${backup.name}...`;

        await sendSSE(writer, encoder, {
          type: "error",
          data: {
            message: retryMessage,
            code: "PROVIDER_RETRY",
            fromModel: model.name,
            fromModelId: model.id,
            fromProvider: model.provider,
            toModel: backup.name,
            toModelId: backup.id,
            toProvider: backup.provider,
            toScore: backup.score,
            toReasoning: backup.reasoning,
            reason: "The primary model encountered an error",
            modeHonored,
            downgradedFrom,
          },
        });

        // Recompute thinking against the backup's provider so the toggle only
        // forces thinking on when the backup supports it; otherwise the value
        // falls back to ADE complexity, matching the rest of the pipeline.
        const backupEnableThinking = resolveThinking(
          adeResponse.analysis,
          backup.provider,
          thinkingPreference
        );

        const backupResult = await streamFromProvider(
          backup,
          systemPrompt,
          history,
          enableWebSearch,
          backupEnableThinking,
          enableImageGeneration,
          effectiveImagePrompt,
          writer,
          encoder,
          apiCallLogs,
          conversationId,
          messageId,
          pendingImages,
          chatReq.images,
          titleContext,
          systemPromptParts,
          log,
          imageQuality,
          imageAspectRatio,
          subConversationId
        );

        if (!backupResult.success) {
          // If image generation was requested, try a dedicated image model as last resort
          if (enableImageGeneration) {
            const dedicatedFallback = await tryDedicatedImageFallback(
              effectiveImagePrompt, model, apiCallLogs, writer, encoder, conversationId, messageId, pendingImages, creditInfo
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
          log.error("All providers failed", undefined, {
            primaryModel: model.id,
            primaryProvider: model.provider,
            backupModel: backup.id,
            backupProvider: backup.provider,
            userFacingError: backupResult.error,
            failedCalls: summarizeFailedCalls(apiCallLogs),
            conversationId,
            messageId,
          });
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
            effectiveImagePrompt, model, apiCallLogs, writer, encoder, conversationId, messageId, pendingImages, creditInfo
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
        log.error("Primary model failed with no backup available", undefined, {
          model: model.id,
          provider: model.provider,
          userFacingError: streamResult.error,
          failedCalls: summarizeFailedCalls(apiCallLogs),
          conversationId,
          messageId,
        });
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
    log.error("Fatal chat error", err);
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
  { id: "gpt-image-2", name: "GPT Image 2", provider: "openai", envKey: "OPENAI_API_KEY" },
  { id: "gpt-image-1.5", name: "GPT Image 1.5", provider: "openai", envKey: "OPENAI_API_KEY" },
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
  pendingImages?: PendingImageMeta[],
  creditInfo?: { userId?: string; imageQuality?: string; imageAspectRatio?: ImageAspectRatio; preChargedResult?: ChargeResult }
): Promise<StreamResult | null> {
  const log = logger.child({ route: "chat", subRoute: "dedicated-image-fallback" });
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
          fromModelId: originalModel.id,
          fromProvider: originalModel.provider,
          toModel: imgModel.name,
          toModelId: imgModel.id,
          toProvider: imgModel.provider,
          reason: "This model doesn't support image generation",
        },
      });

      const imageResult = await generateImage(imgModel.provider, imgModel.id, prompt, { quality: (creditInfo?.imageQuality ?? "standard") as import("@/lib/providers/image").ImageQuality, aspectRatio: creditInfo?.imageAspectRatio });
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
          log.error("Image storage upload failed", uploadErr, { stage: "dedicated-fallback" });
        }
      }

      // Charge credits after successful upload, before confirming image to client.
      if (pendingImages && pendingImages.length > 0 && creditInfo?.userId) {
        try {
          const chargeResult = await chargeCredits(creditInfo.userId, creditInfo.imageQuality ?? "standard", {
            modelUsed: imgModel.id,
            provider: imgModel.provider,
            conversationId,
            messageId,
            prompt,
          });
          if (!chargeResult.charged) {
            await sendSSE(writer, encoder, { type: "error", data: { message: "Insufficient image credits", code: "INSUFFICIENT_CREDITS" } });
            await writer.close();
            return null;
          }
          if (creditInfo) creditInfo.preChargedResult = chargeResult;
        } catch (chargeErr) {
          log.error("Image credit charge failed", chargeErr, { stage: "dedicated-fallback" });
          await sendSSE(writer, encoder, { type: "error", data: { message: "Failed to charge image credits. Please try again.", code: "CREDIT_CHARGE_FAILED" } });
          await writer.close();
          return null;
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
          quality: creditInfo?.imageQuality ?? "standard",
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

interface TitleContext {
  conversationId: string;
  placeholderTitle: string;
  requestId?: string;
}

async function streamFromProvider(
  model: ModelInfo,
  systemPrompt: string,
  history: ConversationMessage[],
  enableWebSearch: boolean,
  enableThinking: boolean,
  enableImageGeneration: boolean,
  userPrompt: string,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  apiCallLogs: ApiCallLogEntry[],
  conversationId?: string,
  messageId?: string,
  pendingImages?: PendingImageMeta[],
  uploadedImages?: ImageAttachment[],
  titleContext?: TitleContext,
  systemPromptParts?: SystemPromptParts,
  parentLog?: Logger,
  imageQuality?: "standard" | "hd" | "ultra",
  imageAspectRatio?: ImageAspectRatio,
  subConversationId?: string
): Promise<StreamResult> {
  const log = (parentLog ?? logger).child({ subRoute: "stream-provider", provider: model.provider, model: model.id });
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

    // Build messages, carrying images through for vision-capable models
    const providerMessages: ConversationMessage[] = history.map((m) => {
      const msg: ConversationMessage = {
        role: m.role,
        content: m.content,
      };
      if (m.images && m.images.length > 0 && supportsVision(model.id)) {
        msg.images = m.images;
      }
      return msg;
    });

    // If images were attached to the current request but not yet in history
    // (e.g. freshly uploaded), attach them to the last user message
    if (uploadedImages && uploadedImages.length > 0 && supportsVision(model.id)) {
      for (let i = providerMessages.length - 1; i >= 0; i--) {
        if (providerMessages[i]!.role === "user" && !providerMessages[i]!.images) {
          providerMessages[i]!.images = uploadedImages;
          break;
        }
      }
    }

    const providerStream = provider.stream({
      modelId: model.id,
      systemPrompt,
      systemPromptParts,
      messages: providerMessages,
      enableThinking,
      enableWebSearch,
      enableImageGeneration,
      imageQuality,
      imageAspectRatio,
    });

    // Tail buffer to prevent <araviel_meta> and <araviel_title> blocks from
    // flashing in the UI. We hold back content once we detect a potential
    // partial tag for either block.
    let tailBuffer = "";
    const META_OPEN = "<araviel_meta>";
    const TITLE_OPEN = "<araviel_title>";

    // Title SSE fires exactly once — post-stream — after the full response is
    // in hand. This avoids mid-stream race conditions and ensures the title is
    // only surfaced when we know the generation succeeded.
    async function emitTitle(title: string): Promise<void> {
      if (!titleContext) return;
      const updated = await updateConversationTitleIfUnchanged(
        titleContext.conversationId,
        titleContext.placeholderTitle,
        title,
        { requestId: titleContext.requestId }
      );
      if (updated) {
        await sendSSE(writer, encoder, {
          type: "title",
          data: { conversationId: titleContext.conversationId, title },
        });
      }
    }

    /**
     * Splice out any complete `<araviel_title>…</araviel_title>` blocks from
     * `tailBuffer` silently — the title SSE is deferred to post-stream so we
     * only strip bytes here to keep them from leaking to the client. Leaves
     * incomplete tags in place so they can continue buffering.
     */
    function absorbBufferedTitle(): void {
      while (true) {
        const openIdx = tailBuffer.indexOf(TITLE_OPEN);
        if (openIdx === -1) return;
        const close = findTitleClose(tailBuffer, openIdx + TITLE_OPEN.length);
        if (!close) return; // wait for the rest

        let after = close.index + close.length;
        // Swallow one surrounding newline pair so stripped blocks don't leave
        // an awkward blank line in the delta stream.
        const before = tailBuffer.slice(0, openIdx);
        if (/\n\s*$/.test(before) && tailBuffer[after] === "\n") {
          after += 1;
        }
        tailBuffer = tailBuffer.slice(0, openIdx) + tailBuffer.slice(after);
      }
    }

    async function flushSafeDelta(chunk: string): Promise<void> {
      tailBuffer += chunk;

      // Strip any complete title blocks anywhere in the buffer before further
      // processing so their bytes never reach the client. The SSE fire itself
      // is deferred to the post-stream pass for stability.
      absorbBufferedTitle();

      // Once we see the start of the meta block, hold everything from that point.
      // If an incomplete title block is also present, hold from whichever comes first.
      const metaIdx = tailBuffer.indexOf(META_OPEN);
      const titleIdx = tailBuffer.indexOf(TITLE_OPEN);

      let holdFrom = -1;
      if (metaIdx !== -1) holdFrom = metaIdx;
      if (titleIdx !== -1 && (holdFrom === -1 || titleIdx < holdFrom)) {
        holdFrom = titleIdx;
      }

      if (holdFrom !== -1) {
        const safe = tailBuffer.slice(0, holdFrom);
        tailBuffer = tailBuffer.slice(holdFrom);
        if (safe) {
          await sendSSE(writer, encoder, { type: "delta", data: { content: safe } });
        }
        return;
      }

      // Check if the tail might be a partial opening tag for either block
      const partialMeta = containsPartialMeta(tailBuffer);
      const partialTitle = containsPartialTitle(tailBuffer);
      if (partialMeta || partialTitle) {
        let holdFromSuffix = tailBuffer.length;
        const candidates = [META_OPEN, TITLE_OPEN];
        for (const tag of candidates) {
          for (let i = 1; i <= tag.length && i <= tailBuffer.length; i++) {
            const suffix = tailBuffer.slice(-i);
            if (tag.startsWith(suffix)) {
              holdFromSuffix = Math.min(holdFromSuffix, tailBuffer.length - i);
              break;
            }
          }
        }
        const safe = tailBuffer.slice(0, holdFromSuffix);
        tailBuffer = tailBuffer.slice(holdFromSuffix);
        if (safe) {
          await sendSSE(writer, encoder, { type: "delta", data: { content: safe } });
        }
        return;
      }

      // No tag risk — flush everything
      const toSend = tailBuffer;
      tailBuffer = "";
      if (toSend) {
        await sendSSE(writer, encoder, { type: "delta", data: { content: toSend } });
      }
    }

    // Persist a partial assistant row every ~2s while the stream is in flight.
    // If Vercel maxDuration kills the function mid-response, the most recent
    // partial save survives so a "Continue" follow-up can see the prior turn.
    let lastPartialPersistAt = 0;
    const PARTIAL_PERSIST_INTERVAL_MS = 2000;
    const persistPartialIfDue = async (): Promise<void> => {
      if (!conversationId || !messageId) return;
      if (!content && !thinkingContent) return;
      const now = Date.now();
      if (now - lastPartialPersistAt < PARTIAL_PERSIST_INTERVAL_MS) return;
      lastPartialPersistAt = now;
      try {
        await upsertPartialAssistantMessage(messageId, conversationId, {
          content,
          thinkingContent,
          subConversationId,
        });
      } catch (err) {
        log.warn("Partial assistant persist failed (non-fatal)", {}, err as Error);
      }
    };

    for await (const event of providerStream) {
      switch (event.type) {
        case "delta":
          if (event.content) {
            content += event.content;
            await flushSafeDelta(event.content);
            await persistPartialIfDue();
          }
          break;
        case "thinking":
          if (event.content) {
            thinkingContent += event.content;
            await sendSSE(writer, encoder, {
              type: "thinking",
              data: { content: event.content },
            });
            await persistPartialIfDue();
          }
          break;
        case "citations":
          if (event.citations) {
            // Providers often accumulate the same citations list across every
            // streamed chunk (e.g. Perplexity, Gemini), so the array we receive
            // here can contain massive duplicate counts. Dedupe by normalized
            // URL before storing and before emitting to the client.
            const uniqueCitations = dedupeCitations([
              ...citations,
              ...event.citations,
            ]);
            citations.length = 0;
            citations.push(...uniqueCitations);
            await sendSSE(writer, encoder, {
              type: "citations",
              data: {
                sources: uniqueCitations.map((c) => ({
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
                log.error("Image storage upload failed", uploadErr, { stage: "native" });
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

    // Post-stream title pass: extract any `<araviel_title>` block from the full
    // accumulated content and fire the `title` SSE exactly once. Keeping this
    // as the single authoritative emit path makes the flow deterministic —
    // whether the model emitted the tag at the start, middle, or end of the
    // response, we only surface the title once the generation has succeeded.
    {
      const { cleanContent: titleStripped, title: finalTitle } =
        extractAravielTitle(content);
      if (titleStripped !== content) {
        content = titleStripped;
      }
      if (finalTitle) {
        await emitTitle(finalTitle);
      }
    }

    // If there's any remaining tail buffer that wasn't part of the meta block, flush it.
    // (This handles the case where the AI didn't produce a meta block at all.)
    const { cleanContent: metaStripped, meta } = extractAravielMeta(content);
    // Final safety net: strip any orphan title markers (e.g. a corrupted close
    // tag that escaped the structured stripper) so the saved/returned content
    // never contains a visible <araviel_title> fragment.
    const cleanContent = stripStrayTitleMarkers(metaStripped);

    // Flush any buffered non-meta content that wasn't sent during streaming.
    // Strip any stray (unclosed or otherwise) title markup so it can never reach
    // the client — the final saved `content` is already cleaned above.
    if (tailBuffer && !tailBuffer.includes(META_OPEN)) {
      const { cleanContent: safeTail } = extractAravielTitle(tailBuffer);
      const sanitizedTail = stripStrayTitleMarkers(safeTail);
      if (sanitizedTail) {
        await sendSSE(writer, encoder, { type: "delta", data: { content: sanitizedTail } });
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
    const details = extractProviderErrorDetails(err);
    const statusCode = details.status ?? 500;

    // Server-side only: client sees a sanitized variant via `error` below,
    // but the original cause (rate limit, auth, upstream 5xx, network) is
    // lost without an explicit log line — `apiCallLogs` lives in memory.
    log.error("Provider stream failed", err, {
      latencyMs,
      statusCode,
      errorCode: details.code,
      errorType: details.type,
      providerRequestId: details.providerRequestId,
      conversationId,
      messageId,
      enableWebSearch,
      enableThinking,
      enableImageGeneration,
      historyLength: history.length,
      partialContentChars: content.length,
      thinkingChars: thinkingContent.length,
    });

    apiCallLogs.push({
      provider: model.provider,
      modelId: model.id,
      statusCode,
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

// Compact failure summary so the route-level "all providers failed" line
// is self-contained in Vercel's log viewer. Full stacks live in the
// per-attempt "Provider stream failed" lines, correlated by `requestId`.
function summarizeFailedCalls(apiCallLogs: ApiCallLogEntry[]): Array<{
  provider: string;
  modelId: string;
  statusCode: number;
  latencyMs: number;
  errorMessage?: string;
}> {
  return apiCallLogs
    .filter((c) => c.statusCode >= 400)
    .map(({ provider, modelId, statusCode, latencyMs, errorMessage }) => ({
      provider,
      modelId,
      statusCode,
      latencyMs,
      errorMessage,
    }));
}

// Pull SDK-specific fields (OpenAI/Anthropic expose `status`, `code`,
// `type`, `request_id` either at the top level or under `.error`) so
// Vercel logs can filter on them. Stack/name/message come via the logger.
function extractProviderErrorDetails(err: unknown): {
  status?: number;
  code?: string | number;
  type?: string;
  providerRequestId?: string;
} {
  if (!err || typeof err !== "object") return {};
  const e = err as {
    status?: unknown;
    code?: unknown;
    type?: unknown;
    request_id?: unknown;
    requestId?: unknown;
    error?: { code?: unknown; type?: unknown; message?: unknown } | null;
  };
  const status = typeof e.status === "number" ? e.status : undefined;
  const code =
    typeof e.code === "string" || typeof e.code === "number"
      ? e.code
      : typeof e.error?.code === "string" || typeof e.error?.code === "number"
        ? (e.error.code as string | number)
        : undefined;
  const type =
    typeof e.type === "string"
      ? e.type
      : typeof e.error?.type === "string"
        ? (e.error.type as string)
        : undefined;
  const providerRequestId =
    typeof e.request_id === "string"
      ? e.request_id
      : typeof e.requestId === "string"
        ? e.requestId
        : undefined;
  return { status, code, type, providerRequestId };
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
  creditInfo?: { userId?: string; imageQuality?: string; wasImageGeneration?: boolean; textCredits?: TextCreditState; preChargedResult?: ChargeResult }
): Promise<void> {
  const log = logger.child({
    route: "chat",
    subRoute: "finalize",
    conversationId,
    userId: creditInfo?.userId,
  });
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

  for (const entry of apiCallLogs) {
    await saveApiCallLog(
      messageId,
      entry.provider,
      entry.modelId,
      entry.statusCode,
      entry.latencyMs,
      entry.errorMessage
    );
  }

  await updateConversationTimestamp(conversationId);

  // Charge credits for image generation, then fetch the authoritative post-charge balance.
  // For dedicated image models (Path A), the charge was pre-applied before the image SSE was sent
  // so creditInfo.preChargedResult is already populated — skip the charge to avoid double-billing.
  // For chat models with native image gen (Path B), the charge happens here.
  // The balance is embedded in the done event so the client never needs a separate round-trip.
  let creditChargeResult: { creditsCharged?: number; remainingBalance?: number } = {};
  let freshImageBalance: CreditBalance | null = null;
  if (creditInfo?.wasImageGeneration && creditInfo?.userId && pendingImages && pendingImages.length > 0) {
    if (creditInfo.preChargedResult) {
      // Already charged atomically before the image SSE — use the stored result.
      creditChargeResult = {
        creditsCharged: creditInfo.preChargedResult.creditsCharged,
        remainingBalance: creditInfo.preChargedResult.remainingBalance,
      };
    } else {
      // Path B: chat model with native image gen — charge now.
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
        log.error("Credit charge failed", err);
      }
    }
    // Always fetch the fresh balance for an authoritative snapshot to embed in the done event.
    try {
      freshImageBalance = await getBalance(creditInfo.userId);
    } catch (err) {
      log.error("Failed to fetch post-charge balance", err);
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
      model: {
        id: model.id,
        name: model.name,
        provider: model.provider,
        score: model.score,
        reasoning: model.reasoning,
      },
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        reasoningTokens: result.usage.reasoningTokens,
        cachedTokens: result.usage.cachedTokens,
        costUsd,
      },
      latencyMs: result.latencyMs,
      adeLatencyMs,
      // Include the full post-charge balance so the client can update both Redux slices
      // directly from this event — no additional round-trip to /api/credits needed.
      ...(freshImageBalance && { imageBalance: freshImageBalance }),
      // Legacy field kept for any client versions that still read data.credits
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
