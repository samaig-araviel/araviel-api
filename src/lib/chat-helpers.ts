import { randomUUID } from "crypto";
import { getSupabase } from "@/lib/supabase";
import type {
  ADEModelResult,
  ADEResponse,
  ChatRequest,
  ConversationMessage,
  DBConversation,
  DBMessage,
  DBSubConversation,
  ImageAttachment,
  ModelInfo,
  SystemPromptParts,
  TokenUsage,
} from "@/lib/types";
import { SUPPORTED_PROVIDERS } from "@/lib/types";
import { getChartInstructions } from "@/lib/prompts/chart-instructions";
import { getArtifactInstructions } from "@/lib/prompts/artifact-instructions";
import { getMessages as getImportedMessages } from "@/lib/imported-conversations";
import type { ThinkingTargetProvider } from "@/lib/thinking-models";
import {
  DEFAULT_THINKING_MODELS,
  isPreferredThinkingModel,
} from "@/lib/thinking-models";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateChatRequest(body: unknown): ChatRequest {
  if (!body || typeof body !== "object") {
    throw new Error("Request body is required");
  }

  const req = body as Record<string, unknown>;

  if (typeof req.message !== "string") {
    throw new Error("message is required and must be a string");
  }

  const messageIsEmpty = req.message.trim() === "";
  const hasImages = Array.isArray(req.images) && req.images.length > 0;
  if (messageIsEmpty && !hasImages) {
    throw new Error("message is required when no images are attached");
  }

  let importedConversationId: string | undefined;
  if (typeof req.importedConversationId === "string" && req.importedConversationId.trim()) {
    if (!UUID_RE.test(req.importedConversationId.trim())) {
      throw new Error("importedConversationId must be a valid UUID");
    }
    importedConversationId = req.importedConversationId.trim();
  }

  return {
    conversationId: typeof req.conversationId === "string" ? req.conversationId : undefined,
    subConversationId: typeof req.subConversationId === "string" ? req.subConversationId : undefined,
    importedConversationId,
    projectId: typeof req.projectId === "string" ? req.projectId : undefined,
    message: req.message.trim(),
    userTier: typeof req.userTier === "string" ? req.userTier : "free",
    userId: typeof req.userId === "string" ? req.userId : undefined,
    modality: typeof req.modality === "string" ? req.modality : "text",
    imageQuality: typeof req.imageQuality === "string" && ["standard", "hd", "ultra"].includes(req.imageQuality)
      ? (req.imageQuality as "standard" | "hd" | "ultra")
      : undefined,
    selectedModelId: typeof req.selectedModelId === "string" ? req.selectedModelId : undefined,
    webSearch: typeof req.webSearch === "boolean" ? req.webSearch : undefined,
    tone: typeof req.tone === "string" ? req.tone : undefined,
    mood: typeof req.mood === "string" ? req.mood : undefined,
    autoStrategy: typeof req.autoStrategy === "string" ? req.autoStrategy : undefined,
    weather: typeof req.weather === "string" ? req.weather : undefined,
    conversationHasImages: typeof req.conversationHasImages === "boolean" ? req.conversationHasImages : undefined,
    images: validateImages(req.images),
    extendedThinking: typeof req.extendedThinking === "boolean" ? req.extendedThinking : undefined,
    deepResearch: typeof req.deepResearch === "boolean" ? req.deepResearch : undefined,
    googleThinking: typeof req.googleThinking === "boolean" ? req.googleThinking : undefined,
  };
}

const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB per image
const MAX_IMAGES = 10;

function validateImages(raw: unknown): ImageAttachment[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (raw.length > MAX_IMAGES) {
    throw new Error(`Too many images: maximum ${MAX_IMAGES} allowed`);
  }

  const images: ImageAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { dataUri, mimeType, fileName } = item as Record<string, unknown>;

    if (typeof dataUri !== "string" || !dataUri.startsWith("data:image/")) {
      throw new Error("Each image must have a valid data URI starting with data:image/");
    }
    if (typeof mimeType !== "string" || !ACCEPTED_IMAGE_TYPES.has(mimeType)) {
      throw new Error(`Unsupported image type: ${mimeType}. Accepted: jpeg, png, gif, webp`);
    }

    // Estimate decoded size from base64 length (base64 is ~4/3 of binary)
    const commaIdx = dataUri.indexOf(",");
    if (commaIdx === -1) throw new Error("Invalid data URI format");
    const base64Length = dataUri.length - commaIdx - 1;
    const estimatedBytes = Math.ceil(base64Length * 0.75);
    if (estimatedBytes > MAX_IMAGE_BYTES) {
      throw new Error(`Image exceeds 2 MB limit (${Math.round(estimatedBytes / 1024)}KB)`);
    }

    images.push({
      dataUri: dataUri as string,
      mimeType: mimeType as string,
      fileName: typeof fileName === "string" ? fileName : undefined,
    });
  }

  return images.length > 0 ? images : undefined;
}

export interface ResolvedConversation {
  id: string;
  /** True when this call inserted a brand-new row; false when the id was provided. */
  isNew: boolean;
  /** The placeholder title written at insert time. Empty when the row pre-existed. */
  placeholderTitle: string;
}

/** Build the truncated placeholder title used on initial insert. */
function buildPlaceholderTitle(messagePreview: string): string {
  return messagePreview.slice(0, 50) + (messagePreview.length > 50 ? "..." : "");
}

export async function getOrCreateConversation(
  conversationId: string | undefined,
  messagePreview: string,
  projectId?: string,
  userId?: string
): Promise<ResolvedConversation> {
  const supabase = getSupabase();

  if (conversationId) {
    // Verify conversation exists and belongs to the user
    let query = supabase
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .is("deleted_at", null);

    if (userId) {
      query = query.eq("user_id", userId);
    }

    const { data, error } = await query.single();

    if (error || !data) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    return { id: conversationId, isNew: false, placeholderTitle: "" };
  }

  const id = randomUUID();
  const placeholderTitle = buildPlaceholderTitle(messagePreview);
  const now = new Date().toISOString();

  const row: Record<string, unknown> = {
    id,
    title: placeholderTitle,
    created_at: now,
    updated_at: now,
  };

  if (projectId) {
    row.project_id = projectId;
  }

  if (userId) {
    row.user_id = userId;
  }

  const { error } = await supabase.from("conversations").insert(row);

  if (error) {
    throw new Error(`Failed to create conversation: ${error.message}`);
  }

  return { id, isNew: true, placeholderTitle };
}

export async function saveUserMessage(
  conversationId: string,
  content: string,
  subConversationId?: string,
  attachments?: ImageAttachment[]
): Promise<string> {
  const supabase = getSupabase();
  const id = randomUUID();

  const row: Record<string, unknown> = {
    id,
    conversation_id: conversationId,
    sub_conversation_id: subConversationId ?? null,
    role: "user",
    content,
    created_at: new Date().toISOString(),
  };

  if (attachments && attachments.length > 0) {
    row.attachments = attachments;
  }

  const { error } = await supabase.from("messages").insert(row);

  if (error) {
    throw new Error(`Failed to save user message: ${error.message}`);
  }

  return id;
}

export async function insertAssistantMessage(
  messageId: string,
  conversationId: string,
  data: {
    content: string;
    modelUsed: Record<string, unknown>;
    usage: TokenUsage;
    costUsd: number;
    latencyMs: number;
    adeLatencyMs: number;
    extendedData: Record<string, unknown>;
    subConversationId?: string;
  }
): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.from("messages").insert({
    id: messageId,
    conversation_id: conversationId,
    sub_conversation_id: data.subConversationId ?? null,
    role: "assistant",
    content: data.content,
    model_used: data.modelUsed,
    tokens_input: data.usage.inputTokens,
    tokens_output: data.usage.outputTokens,
    tokens_reasoning: data.usage.reasoningTokens,
    tokens_cached: data.usage.cachedTokens,
    cost_usd: data.costUsd,
    latency_ms: data.latencyMs,
    ade_latency_ms: data.adeLatencyMs,
    extended_data: data.extendedData,
    created_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`Failed to insert assistant message: ${error.message}`);
  }
}

export async function updateConversationTimestamp(
  conversationId: string
): Promise<void> {
  const supabase = getSupabase();

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId)
    .is("deleted_at", null);
}

export async function saveRoutingLog(
  messageId: string,
  adeResponse: ADEResponse,
  adeLatencyMs: number
): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase.from("routing_logs").insert({
    id: randomUUID(),
    message_id: messageId,
    prompt: "",
    recommended_model: adeResponse.primaryModel,
    alternative_models: adeResponse.backupModels,
    analysis: adeResponse.analysis,
    scoring_breakdown: adeResponse.timing,
    ade_latency_ms: adeLatencyMs,
    created_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`Failed to save routing log: ${error.message}`);
  }
}

export async function saveApiCallLog(
  messageId: string,
  provider: string,
  modelId: string,
  statusCode: number,
  latencyMs: number,
  errorMessage?: string,
  retryCount?: number
): Promise<void> {
  const supabase = getSupabase();

  await supabase.from("api_call_logs").insert({
    id: randomUUID(),
    message_id: messageId,
    provider,
    model_id: modelId,
    status_code: statusCode,
    latency_ms: latencyMs,
    error_message: errorMessage ?? null,
    retry_count: retryCount ?? 0,
    created_at: new Date().toISOString(),
  });
}

export async function fetchConversationHistory(
  conversationId: string,
  subConversationId?: string
): Promise<ConversationMessage[]> {
  const supabase = getSupabase();

  if (subConversationId) {
    // For sub-conversations: fetch the highlighted text as context,
    // then return the sub-conversation's own message history
    const { data: subConv } = await supabase
      .from("sub_conversations")
      .select("highlighted_text")
      .eq("id", subConversationId)
      .single();

    const contextMessages: ConversationMessage[] = [];
    if (subConv?.highlighted_text) {
      contextMessages.push({
        role: "system",
        content: `The user is asking a follow-up question about this specific text they highlighted from a previous response:\n\n"${subConv.highlighted_text}"\n\nRespond in the context of this highlighted text.`,
      });
    }

    const { data, error } = await supabase
      .from("messages")
      .select("role, content, attachments")
      .eq("sub_conversation_id", subConversationId)
      .order("created_at", { ascending: true })
      .limit(20);

    if (error) {
      throw new Error(`Failed to fetch sub-conversation history: ${error.message}`);
    }

    const messages = (data ?? []).map((msg: Pick<DBMessage, "role" | "content" | "attachments">) => ({
      role: msg.role as ConversationMessage["role"],
      content: msg.content,
    }));

    // Attach images from the last user message only (avoids resending old images to providers)
    attachImagesFromLastUserMessage(messages, data ?? []);

    return pruneOrphanUserMessages([...contextMessages, ...messages]);
  }

  // Main conversation: exclude sub-conversation messages
  const { data, error } = await supabase
    .from("messages")
    .select("role, content, attachments")
    .eq("conversation_id", conversationId)
    .is("sub_conversation_id", null)
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    throw new Error(`Failed to fetch conversation history: ${error.message}`);
  }

  const messages = (data ?? []).map((msg: Pick<DBMessage, "role" | "content" | "attachments">) => ({
    role: msg.role as ConversationMessage["role"],
    content: msg.content,
  }));

  // Attach images from the last user message only
  attachImagesFromLastUserMessage(messages, data ?? []);

  return pruneOrphanUserMessages(messages);
}

/**
 * Drop user messages that are immediately followed by another user message.
 * Those are previous turns where the assistant never produced a saved reply
 * (the request failed before the done event), so leaving them in the history
 * sent to the provider would create back-to-back user turns and confuse the
 * model. The most recent user message — the current request — is always
 * kept because nothing follows it yet.
 */
export function pruneOrphanUserMessages(
  messages: ConversationMessage[]
): ConversationMessage[] {
  if (messages.length <= 1) return messages;
  const pruned: ConversationMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i]!;
    const next = messages[i + 1];
    if (current.role === "user" && next && next.role === "user") continue;
    pruned.push(current);
  }
  return pruned;
}

/**
 * Find the last user message in the fetched DB rows that has attachments,
 * and populate its `images` field on the corresponding ConversationMessage.
 * Only the most recent user message with images is populated to avoid
 * resending old images to the provider (saves tokens). Earlier user
 * messages that originally carried attachments are given a short textual
 * placeholder so the provider never receives an empty-content user turn —
 * Anthropic rejects those with `messages.X: user messages must have
 * non-empty content`.
 */
export function attachImagesFromLastUserMessage(
  messages: ConversationMessage[],
  dbRows: Array<Pick<DBMessage, "role" | "content" | "attachments">>
): void {
  let attachedIdx = -1;
  for (let i = dbRows.length - 1; i >= 0; i--) {
    const row = dbRows[i]!;
    if (row.role !== "user" || !row.attachments) continue;
    const attachments = row.attachments as ImageAttachment[];
    if (!Array.isArray(attachments) || attachments.length === 0) continue;
    messages[i]!.images = attachments;
    attachedIdx = i;
    break;
  }

  for (let i = 0; i < dbRows.length; i++) {
    if (i === attachedIdx) continue;
    const row = dbRows[i]!;
    if (row.role !== "user") continue;
    const attachments = row.attachments as ImageAttachment[] | null | undefined;
    const hadAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!hadAttachments) continue;
    const msg = messages[i]!;
    if (!msg.content || msg.content.trim() === "") {
      msg.content = attachments.length > 1 ? `[${attachments.length} images]` : "[image]";
    }
  }
}

/**
 * Fetch messages from an imported conversation and convert them to
 * ConversationMessage format suitable for prepending to native history.
 */
export async function fetchImportedConversationHistory(
  importedConversationId: string,
  userId: string
): Promise<ConversationMessage[]> {
  const messages = await getImportedMessages(importedConversationId, userId);

  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as ConversationMessage["role"],
      content: m.content,
    }));
}

export async function getPreviousModelId(
  conversationId: string
): Promise<string | undefined> {
  const supabase = getSupabase();

  const { data } = await supabase
    .from("messages")
    .select("model_used")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1);

  if (data?.[0]?.model_used) {
    const modelUsed = data[0].model_used as Record<string, unknown>;
    const model = modelUsed.model as Record<string, unknown> | undefined;
    return model?.id as string | undefined;
  }

  return undefined;
}

export function resolveModel(
  adeResponse: ADEResponse,
  selectedModelId?: string
): {
  model: ModelInfo;
  backupModels: ModelInfo[];
  isManualSelection: boolean;
} {
  const toModelInfo = (m: ADEModelResult): ModelInfo => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    score: m.score,
    reasoning: m.reasoning.summary,
  });

  if (selectedModelId) {
    const allModels = [adeResponse.primaryModel, ...adeResponse.backupModels];
    const selected = allModels.find((m) => m.id === selectedModelId);

    if (selected) {
      const others = allModels.filter((m) => m.id !== selectedModelId);
      return {
        model: toModelInfo(selected),
        backupModels: others.map(toModelInfo),
        isManualSelection: true,
      };
    }

    return {
      model: {
        id: selectedModelId,
        name: selectedModelId,
        provider: guessProviderFromModelId(selectedModelId),
        score: 0,
        reasoning: "Manually selected by user",
      },
      backupModels: [adeResponse.primaryModel, ...adeResponse.backupModels].map(toModelInfo),
      isManualSelection: true,
    };
  }

  const primary = adeResponse.primaryModel;
  if (SUPPORTED_PROVIDERS.has(primary.provider)) {
    return {
      model: toModelInfo(primary),
      backupModels: adeResponse.backupModels.map(toModelInfo),
      isManualSelection: false,
    };
  }

  for (const backup of adeResponse.backupModels) {
    if (SUPPORTED_PROVIDERS.has(backup.provider)) {
      const others = adeResponse.backupModels.filter((m) => m.id !== backup.id);
      return {
        model: toModelInfo(backup),
        backupModels: [toModelInfo(primary), ...others.map(toModelInfo)],
        isManualSelection: false,
      };
    }
  }

  throw new Error(
    "No supported provider available. ADE recommended providers that are not yet supported."
  );
}

function guessProviderFromModelId(modelId: string): string {
  if (modelId.startsWith("claude")) return "anthropic";
  if (modelId.startsWith("gpt") || modelId.startsWith("o3") || modelId.startsWith("o4") || modelId.startsWith("gpt-image")) return "openai";
  if (modelId.startsWith("gemini") || modelId.startsWith("imagen")) return "google";
  if (modelId.startsWith("sonar")) return "perplexity";
  if (modelId.startsWith("stable-diffusion")) return "stability";
  return "openai";
}

/** Dedicated image generation models that use separate image APIs (not chat/streaming). */
const DEDICATED_IMAGE_MODELS = new Set([
  "gpt-image-2",
  "gpt-image-1.5",
  "gpt-image-1-mini",
  "imagen-4",
  "imagen-3",
  "stable-diffusion-3.5",
]);

export function isImageGenerationModel(modelId: string): boolean {
  return DEDICATED_IMAGE_MODELS.has(modelId);
}

/**
 * Chat models that support native image generation via provider-specific tools.
 * OpenAI: image_generation tool in Responses API (GPT-4o, GPT-4.1, GPT-5 series, o3).
 * Google: responseModalities for Gemini image-capable models only.
 * Models NOT in this set should fall back to a dedicated image model.
 */
const NATIVE_IMAGE_GEN_MODELS = new Set([
  // OpenAI — image_generation tool in Responses API
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-5",
  "gpt-5.2",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5-nano",
  "o3",
  // Google — responseModalities (only -image model variants).
  // `gemini-3.1-flash-image-preview` was retired 2026-06-25 and is coerced to
  // the GA `gemini-3.1-flash-image` upstream in retired-models.ts.
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-image",
  "gemini-3-pro-image-preview",
]);

/**
 * Check whether a model can generate images — either as a dedicated image model
 * or as a chat model with verified native image generation support.
 */
export function canModelGenerateImages(modelId: string): boolean {
  return DEDICATED_IMAGE_MODELS.has(modelId) || NATIVE_IMAGE_GEN_MODELS.has(modelId);
}

/** Models that do NOT support vision (image input for analysis). */
const NON_VISION_MODELS = new Set([
  // Dedicated image generation models
  "gpt-image-2", "gpt-image-1.5", "gpt-image-1-mini",
  "imagen-4", "imagen-3",
  "stable-diffusion-3.5",
  // TTS / audio-only models
  "gpt-4o-mini-tts",
  "elevenlabs-tts-flash", "elevenlabs-tts-multilingual", "elevenlabs-music",
  // Video-only models
  "veo-3.1",
]);

/**
 * Check whether a model supports vision (image input for analysis).
 * All main text/chat models support vision; only dedicated image-gen,
 * TTS, and video models do not.
 */
export function supportsVision(modelId: string): boolean {
  return !NON_VISION_MODELS.has(modelId);
}

/**
 * Returns a list of image-capable models we support, grouped by type,
 * for use in user-facing fallback messages.
 */
export function getImageCapableModels(): {
  dedicated: Array<{ id: string; name: string; provider: string }>;
  nativeChat: Array<{ id: string; name: string; provider: string }>;
} {
  return {
    dedicated: [
      { id: "gpt-image-2", name: "GPT Image 2", provider: "OpenAI" },
      { id: "gpt-image-1.5", name: "GPT Image 1.5", provider: "OpenAI" },
      { id: "gpt-image-1-mini", name: "GPT Image 1 Mini", provider: "OpenAI" },
      { id: "imagen-4", name: "Imagen 4", provider: "Google" },
      { id: "stable-diffusion-3.5", name: "Stable Diffusion 3.5", provider: "Stability AI" },
    ],
    nativeChat: [
      { id: "gpt-5.4", name: "GPT-5.4", provider: "OpenAI" },
      { id: "gpt-4o", name: "GPT-4o", provider: "OpenAI" },
      { id: "gpt-4.1", name: "GPT-4.1", provider: "OpenAI" },
      { id: "gemini-3.1-flash-image", name: "Nano Banana 2", provider: "Google" },
      { id: "gemini-2.5-flash-image", name: "Nano Banana", provider: "Google" },
    ],
  };
}

export interface UserSettingsForPrompt {
  customInstructions?: string;
  responseTone?: string;
  occupation?: string;
  expertise?: string;
  preferredLanguage?: string;
}

export async function getUserSettingsForChat(userId: string): Promise<UserSettingsForPrompt | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("user_settings")
    .select("custom_instructions, response_tone, occupation, expertise, preferred_language")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) return null;

  return {
    customInstructions: data.custom_instructions || "",
    responseTone: data.response_tone || "default",
    occupation: data.occupation || "",
    expertise: data.expertise || "",
    preferredLanguage: data.preferred_language || "English",
  };
}

/**
 * Read the user's "Location metadata" consent flag from Settings >
 * Data & privacy. Used by the chat route to drop location-derived fields
 * (e.g. weather) before they reach the model when the user has opted out.
 *
 * Defaults to `false` (privacy-by-default) on missing row or query error —
 * never grant access on uncertainty.
 */
export async function getLocationMetadataConsent(userId: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("user_settings")
    .select("location_metadata")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) return false;
  return data.location_metadata === true;
}

/**
 * Did the previous assistant turn in this conversation use web search?
 *
 * Used by `resolveWebSearch` so a short follow-up like "hourly table for
 * Maidstone" inherits the search context from the prior weather answer
 * even when the words alone don't betray a real-time intent. Returns
 * false for new conversations, missing rows, or query errors — the
 * conservative default that costs nothing on uncertainty.
 */
export async function getPreviousAssistantWebSearchUsed(
  conversationId: string
): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("messages")
    .select("model_used")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .is("sub_conversation_id", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return false;
  const modelUsed = data.model_used as { webSearchUsed?: boolean } | null;
  return modelUsed?.webSearchUsed === true;
}

/**
 * Structured form of the system prompt for caching-aware providers
 * (currently Anthropic). Splits the prompt at the stable / variable
 * boundary so the provider can place a cache breakpoint on the stable
 * block.
 *
 * Compared to `buildSystemPrompt`, this moves title instructions out of
 * the prepended position and into the `variable` block. The directive
 * wording inside `getTitleInstructions()` already pins the `<araviel_title>`
 * output to the start of the response regardless of where the instruction
 * appears in the prompt, so model behavior is preserved.
 *
 * For caching to work, the `stable` output must be byte-identical across
 * requests that share the same flags. Do not interpolate timestamps,
 * UUIDs, or any other volatile data into the helpers that feed it.
 */
export function buildSystemPromptParts(
  projectInstructions?: string,
  options?: {
    includeFileInstructions?: boolean;
    includeTitleInstructions?: boolean;
    userSettings?: UserSettingsForPrompt | null;
  }
): SystemPromptParts {
  const basePrompt = [
    "You are a helpful AI assistant powered by Araviel, an intelligent AI platform.",
    "Provide clear, accurate, and well-structured responses.",
    "Do not use emojis in your responses. Keep your tone professional and clean.",
    "Be concise but thorough. If you are unsure about something, say so.",
  ].join(" ");

  let stable = `${basePrompt}\n\n${getFormattingInstructions()}\n\n${getChartInstructions()}`;
  stable += `\n\n${getRichBlockInstructions()}`;
  stable += `\n\n${getArtifactInstructions()}`;
  if (options?.includeFileInstructions) {
    stable += `\n\n${getFileBlockInstructions()}`;
  }
  stable += `\n\n${getFollowUpInstructions()}`;

  const variableParts: string[] = [];
  if (options?.includeTitleInstructions) {
    variableParts.push(getTitleInstructions());
  }
  if (projectInstructions && projectInstructions.trim()) {
    variableParts.push(
      `--- Project Instructions ---\nThe following instructions were set by the user for this project. Follow them for all responses in this conversation:\n\n${projectInstructions}`
    );
  }
  const userPrefsBlock = renderUserPreferencesBlock(options?.userSettings);
  if (userPrefsBlock) {
    variableParts.push(userPrefsBlock);
  }

  return {
    stable,
    variable: variableParts.length > 0 ? variableParts.join("\n\n") : undefined,
  };
}

/**
 * Renders the "--- User Preferences ---" block from user settings, or
 * returns `null` if no preference fields are set. Used by both
 * `buildSystemPrompt` and `buildSystemPromptParts` so the user-prefs
 * serialization stays consistent.
 */
function renderUserPreferencesBlock(us: UserSettingsForPrompt | null | undefined): string | null {
  if (!us) return null;
  const parts: string[] = [];
  if (us.responseTone && us.responseTone !== "default") {
    const toneInstructions: Record<string, string> = {
      professional: "Respond in a polished, precise, and professional tone.",
      friendly: "Respond in a warm, chatty, and approachable tone.",
      candid: "Respond in a direct, encouraging, and straightforward tone. Be honest and get to the point.",
      quirky: "Respond in a playful, imaginative, and creative tone. Be inventive with your language.",
      efficient: "Respond concisely and plainly. Keep answers short, direct, and to the point.",
      cynical: "Respond with a critical, skeptical, and sarcastic edge. Be blunt and unfiltered.",
    };
    parts.push(toneInstructions[us.responseTone] ?? `Respond in a ${us.responseTone} tone.`);
  }
  if (us.preferredLanguage && us.preferredLanguage !== "English") {
    parts.push(`Respond in ${us.preferredLanguage}.`);
  }
  if (us.occupation) {
    parts.push(`The user's occupation is: ${us.occupation}.`);
  }
  if (us.expertise) {
    parts.push(`The user has expertise in: ${us.expertise}. Adjust technical depth accordingly.`);
  }
  if (us.customInstructions && us.customInstructions.trim()) {
    parts.push(`The user has provided the following personal instructions. Follow them for all responses:\n\n${us.customInstructions}`);
  }
  if (parts.length === 0) return null;
  return `--- User Preferences ---\n${parts.join("\n")}`;
}

export function buildSystemPrompt(
  projectInstructions?: string,
  options?: {
    includeFileInstructions?: boolean;
    includeTitleInstructions?: boolean;
    userSettings?: UserSettingsForPrompt | null;
  }
): string {
  const basePrompt = [
    "You are a helpful AI assistant powered by Araviel, an intelligent AI platform.",
    "Provide clear, accurate, and well-structured responses.",
    "Do not use emojis in your responses. Keep your tone professional and clean.",
    "Be concise but thorough. If you are unsure about something, say so.",
  ].join(" ");

  let prompt = `${basePrompt}\n\n${getFormattingInstructions()}\n\n${getChartInstructions()}`;

  prompt += `\n\n${getRichBlockInstructions()}`;

  prompt += `\n\n${getArtifactInstructions()}`;

  if (options?.includeFileInstructions) {
    prompt += `\n\n${getFileBlockInstructions()}`;
  }

  if (options?.includeTitleInstructions) {
    // Prepended via concatenation so this block is the first thing the model
    // generates on a brand-new conversation. The `<araviel_title>…</araviel_title>`
    // block is parsed and stripped server-side — the user never sees it.
    prompt = `${getTitleInstructions()}\n\n${prompt}`;
  }

  prompt += `\n\n${getFollowUpInstructions()}`;

  if (projectInstructions && projectInstructions.trim()) {
    prompt += `\n\n--- Project Instructions ---\nThe following instructions were set by the user for this project. Follow them for all responses in this conversation:\n\n${projectInstructions}`;
  }

  // Inject user preferences into the system prompt
  const userPrefsBlock = renderUserPreferencesBlock(options?.userSettings);
  if (userPrefsBlock) {
    prompt += `\n\n${userPrefsBlock}`;
  }

  return prompt;
}

function getFormattingInstructions(): string {
  return `## Response Formatting

You MUST use rich markdown formatting in every response. Plain-text walls are not acceptable. Follow these rules:

### Structure
- Use **headings** (##, ###) to organize sections in any response longer than 2 paragraphs.
- Use **bold** for key terms, names, and important concepts on first mention.
- Use *italics* for emphasis, definitions, and nuance.
- Use \`inline code\` for function names, file paths, commands, variable names, and technical identifiers.

### Lists
- Use **numbered lists** (1. 2. 3.) for sequential steps, ranked items, or processes with a natural order.
- Use **bullet lists** (- item) for non-sequential collections, features, pros/cons, or options.
- Use **nested lists** when sub-points clarify a parent item.
- NEVER present more than 3 related items as a comma-separated sentence — use a list instead.

### Tables
- Use **markdown tables** when comparing 2+ items across 2+ attributes.
- Always include a header row and alignment.
- Prefer tables over side-by-side descriptions for structured comparisons.

### Code
- Use fenced code blocks (\`\`\`language) for any code, commands, configs, or structured output.
- Always specify the language tag for syntax highlighting.
- Keep code blocks focused — one concept per block.

### Blockquotes
- Use **blockquotes** (> ) for important notes, warnings, caveats, or callouts.
- Start with a bold label: > **Note:** or > **Warning:**

### General
- Break long responses into clear sections with headings.
- Lead with a concise summary or direct answer before elaborating.
- Use horizontal rules (---) to separate major topic shifts within a single response.
- Every response should be scannable — a reader should understand the structure at a glance.`;
}

function getRichBlockInstructions(): string {
  return `## Rich Content Blocks

In addition to standard markdown, you can emit special fenced code blocks that render as interactive visual components. Use these when they genuinely improve comprehension — do NOT overuse them.

### Timeline Block
Use \`\`\`timeline for chronological events, historical progressions, project milestones, or any sequence of dated/ordered events.

**Simple format** (for basic 3–5 event timelines): JSON array of objects.

Example:
\`\`\`timeline
[
  {"date": "2020", "title": "Project Founded", "description": "Initial team of 3 engineers started development"},
  {"date": "2021 Q2", "title": "Beta Launch", "description": "Opened to 500 beta users"},
  {"date": "2022", "title": "General Availability", "description": "Public launch with 10k users on day one"},
  {"date": "2023", "title": "Series B", "description": "Raised $50M at $400M valuation"}
]
\`\`\`

**Era-grouped format** (for richer timelines with 6+ events spanning multiple periods): JSON object with "eras" array. Each era has a name, color, and events. Choose a "style" to control the visual appearance — vary the style based on the content so timelines feel unique and appropriate to their subject.

Three styles are available:

- **"editorial"** (default): Clean left-aligned flowing text with colored dots and era name labels. Best for historical events, biographies, general chronologies.
- **"cards"**: Center-line alternating cards on desktop with subtle tinted backgrounds. Best for project milestones, product launches, comparative timelines where visual weight helps.
- **"compact"**: Dense single-column with tighter spacing. Best for day-by-day or hour-by-hour events, detailed sequences within a short timeframe.

Example (editorial style):
\`\`\`timeline
{
  "title": "History of Computing",
  "style": "editorial",
  "eras": [
    {
      "name": "Mechanical Era",
      "color": "#8B5CF6",
      "events": [
        {"date": "1837", "title": "Analytical Engine", "description": "Babbage designs the first general-purpose computer concept"},
        {"date": "1890", "title": "Tabulating Machine", "description": "Hollerith's machine processes the US Census"}
      ]
    },
    {
      "name": "Electronic Era",
      "color": "#0EA5E9",
      "events": [
        {"date": "1945", "title": "ENIAC", "description": "First general-purpose electronic computer"},
        {"date": "1947", "title": "Transistor Invented", "description": "Bell Labs revolutionizes electronics"}
      ]
    }
  ]
}
\`\`\`

Example (compact style with sublabels):
\`\`\`timeline
{
  "title": "Easter Weekend",
  "style": "compact",
  "eras": [
    {
      "name": "Friday — The Crucifixion",
      "color": "#EF4444",
      "events": [
        {"date": "Morning", "title": "Trial before Pilate", "description": "Jesus is condemned to death", "sublabel": "John 18:28-40"},
        {"date": "~9 AM", "title": "Crucifixion", "description": "Jesus is crucified at Golgotha", "sublabel": "Mark 15:25"}
      ]
    }
  ]
}
\`\`\`

Rules:
- Use when showing 3–15 chronological or sequential events.
- "date" or "label" is required as the timeline marker (short, under 20 characters).
- "title" is the event heading (under 60 characters).
- "description" is optional additional context (under 150 characters).
- "sublabel" is optional metadata — location, scripture reference, source citation (under 60 characters).
- Order items chronologically.
- Use the eras format when events span multiple distinct periods or categories, when color grouping would improve comprehension, or when there are 6+ events that benefit from visual organization.
- Choose distinct, visually appealing hex colors for each era. Good defaults: #8B5CF6 (purple), #D97706 (amber), #0EA5E9 (sky blue), #10B981 (emerald), #F43F5E (rose), #06B6D4 (cyan).
- IMPORTANT: Vary the style based on content. Do not always use the same style. Choose the style that best fits the timeline's nature and density.

### Comparison Block
Use \`\`\`comparison for side-by-side feature comparisons, pros/cons, tool evaluations, or option analysis.

Format: JSON object with "items" array. Each item has "name", and any combination of "pros", "cons", "features" (arrays of strings), or "description" (string).

Example:
\`\`\`comparison
{
  "items": [
    {
      "name": "React",
      "description": "Component-based UI library by Meta",
      "pros": ["Huge ecosystem", "Strong job market", "Flexible architecture"],
      "cons": ["Boilerplate heavy", "No built-in routing", "JSX learning curve"]
    },
    {
      "name": "Vue",
      "description": "Progressive framework with gentle learning curve",
      "pros": ["Easy to learn", "Great docs", "Built-in state management"],
      "cons": ["Smaller ecosystem", "Fewer jobs", "Less enterprise adoption"]
    }
  ]
}
\`\`\`

Rules:
- Use for 2–4 items being compared.
- Each item must have a "name".
- Include at least "pros"/"cons" OR "features" for each item.
- Keep each pro/con/feature string under 50 characters.
- "description" is optional (under 100 characters).

### Steps Block
Use \`\`\`steps for how-to guides, setup instructions, tutorials, recipes, or any multi-step process.

Format: JSON array of objects with "title" and "description" fields. Optional "code" field for a command or snippet.

Example:
\`\`\`steps
[
  {"title": "Install dependencies", "description": "Add the required packages to your project", "code": "npm install express cors helmet"},
  {"title": "Create server file", "description": "Set up the entry point with basic middleware configuration"},
  {"title": "Add routes", "description": "Define your API endpoints in a separate routes directory"},
  {"title": "Start the server", "description": "Run in development mode with hot reload", "code": "npm run dev"}
]
\`\`\`

Rules:
- Use when there are 3–10 sequential steps to follow.
- Each step must have "title" (under 60 characters) and "description" (under 200 characters).
- "code" is optional — include only when a specific command or snippet is needed for that step.
- Steps are automatically numbered in the UI.

### When to use rich blocks vs standard markdown
- Use \`\`\`timeline instead of a numbered list when items are date-labeled events.
- Use \`\`\`comparison instead of a table when comparing items with pros/cons or detailed attributes.
- Use \`\`\`steps instead of a numbered list when giving procedural instructions with explanations per step.
- For simple lists (under 5 items, no extra detail needed), prefer standard markdown lists.
- Always place rich blocks AFTER your text analysis, not as a replacement for it.`;
}

function getFileBlockInstructions(): string {
  return `## File Downloads

When the user asks you to generate a downloadable file (e.g., "give me this as a PDF", "export to Excel", "create a Word document", "download as CSV"), you MUST emit a \`\`\`file code block containing a JSON specification. The frontend will generate the actual file client-side and display a download card.

IMPORTANT: Only emit a \`\`\`file block when the user explicitly requests a file download or export. Do NOT proactively generate files.

### Supported Formats
pdf, docx, xlsx, pptx, csv, txt, json, html, md, xml, sql, yaml

### JSON Spec Format

Every file block MUST contain valid JSON with these fields:
- "filename" (required): Full filename with extension (e.g., "report.pdf", "data.xlsx")
- "format" (required): One of the supported format strings above
- "title" (optional): Human-readable title for the document
- "subtitle" (optional): Secondary description
- "content" (required): Format-specific content structure (see below)

### Document Formats (PDF, DOCX, TXT, HTML, MD)

Use a "sections" array for structured documents:

\`\`\`file
{
  "filename": "market-analysis.pdf",
  "format": "pdf",
  "title": "Q4 Market Analysis Report",
  "subtitle": "Prepared by Araviel AI",
  "content": {
    "sections": [
      {"type": "heading", "text": "Executive Summary", "level": 1},
      {"type": "paragraph", "text": "This report provides a comprehensive analysis of Q4 market trends..."},
      {"type": "heading", "text": "Key Metrics", "level": 2},
      {"type": "table", "headers": ["Metric", "Q3", "Q4", "Change"], "rows": [["Revenue", "$1.2M", "$1.5M", "+25%"], ["Users", "5,000", "8,200", "+64%"]]},
      {"type": "heading", "text": "Recommendations", "level": 2},
      {"type": "list", "items": ["Expand into emerging markets", "Increase marketing spend by 15%", "Launch mobile app by Q2"], "ordered": true},
      {"type": "code", "text": "SELECT SUM(revenue) FROM sales WHERE quarter = 'Q4'", "language": "sql"},
      {"type": "divider"},
      {"type": "paragraph", "text": "For questions, contact the analytics team."}
    ]
  }
}
\`\`\`

Section types: "heading" (with level 1-3), "paragraph", "table" (with headers + rows), "list" (with items + ordered boolean), "code" (with text + optional language), "divider".

### Spreadsheet Formats (XLSX, CSV)

Use "sheets" array (XLSX can have multiple sheets; CSV uses first sheet only):

\`\`\`file
{
  "filename": "sales-data.xlsx",
  "format": "xlsx",
  "title": "Sales Report",
  "content": {
    "sheets": [
      {
        "name": "Revenue",
        "headers": ["Month", "Product", "Revenue", "Units Sold"],
        "rows": [
          ["January", "Widget A", 45000, 1200],
          ["January", "Widget B", 32000, 800],
          ["February", "Widget A", 52000, 1400]
        ]
      },
      {
        "name": "Summary",
        "headers": ["Quarter", "Total Revenue", "Growth"],
        "rows": [["Q1", 250000, "12%"], ["Q2", 310000, "24%"]]
      }
    ]
  }
}
\`\`\`

### Presentation Format (PPTX)

Use "slides" array:

\`\`\`file
{
  "filename": "project-update.pptx",
  "format": "pptx",
  "title": "Project Status Update",
  "content": {
    "slides": [
      {"title": "Project Alpha - Status Update", "content": "Q4 2024 Review"},
      {"title": "Key Achievements", "content": ["Launched v2.0 to production", "Onboarded 500 new enterprise users", "Reduced infrastructure costs by 30%"]},
      {"title": "Financial Overview", "table": {"headers": ["Metric", "Target", "Actual"], "rows": [["Revenue", "$2M", "$2.3M"], ["Costs", "$800K", "$720K"]]}},
      {"title": "Next Steps", "content": ["Hire 3 additional engineers", "Launch mobile app beta", "Expand to EU market"], "notes": "Discuss timeline with stakeholders"}
    ]
  }
}
\`\`\`

Slide content can be: a string (displayed as body text), an array of strings (rendered as bullet points), or omitted if a table is provided. Optional "notes" field adds speaker notes. Optional "table" with headers + rows renders a table on the slide.

### Code/Data Formats (JSON, XML, SQL, YAML)

Use raw string content:

\`\`\`file
{
  "filename": "schema.sql",
  "format": "sql",
  "content": "CREATE TABLE users (\\n  id SERIAL PRIMARY KEY,\\n  email VARCHAR(255) UNIQUE NOT NULL,\\n  created_at TIMESTAMP DEFAULT NOW()\\n);"
}
\`\`\`

For JSON format, "content" can be an object/array and will be pretty-printed:

\`\`\`file
{
  "filename": "config.json",
  "format": "json",
  "content": {"data": [{"id": 1, "name": "Example"}]}
}
\`\`\`

### Rules
1. ONLY generate a file block when the user explicitly requests a downloadable file or export.
2. Always provide your normal text response BEFORE the file block — explain what the file contains.
3. The filename must have the correct extension matching the format.
4. For document formats (pdf, docx), use the sections structure for rich formatting — do NOT pass raw text when sections would be more appropriate.
5. For spreadsheets, always include headers.
6. Keep data realistic and consistent with your response text.
7. You can include multiple file blocks in one response if the user asks for multiple formats.
8. Common triggers: "download as...", "export to...", "give me a PDF of...", "create a spreadsheet with...", "save this as...", "generate a file...", "I need a Word doc...".
9. If the user asks for a format not in the supported list, use the closest match (e.g., .doc → docx, .xls → xlsx) and mention it.`;
}

function getTitleInstructions(): string {
  return `--- Conversation Title ---
This is the very first message in a brand-new conversation. Before anything else, emit a concise, human-readable title for this conversation. The title will be parsed out and stripped from the visible response — the user will never see this block.

Format:
<araviel_title>Your title here</araviel_title>

Rules:
1. The title must be 3 to 7 words, in sentence case (capitalize the first word and proper nouns only).
2. Be specific to the user's actual topic (e.g. "Diagnosing pytest Docker OOM"), not generic like "Help with code" or "User question".
3. No trailing punctuation, no quotes, no markdown, no emoji.
4. Output the <araviel_title> block FIRST, before any other content. Then continue with your normal response immediately after the closing tag.
5. Do NOT mention or reference the title block in your visible response.`;
}

function getFollowUpInstructions(): string {
  return `--- Follow-Up & Questions ---
At the very end of EVERY response, you MUST append a metadata block. This block will be parsed and stripped — the user will never see it. It must be the absolute last thing in your response.

Format:
<araviel_meta>
{"followUps":["suggestion 1","suggestion 2","suggestion 3","suggestion 4","suggestion 5"],"questions":[]}
</araviel_meta>

CRITICAL RULES:
1. "followUps" — ALWAYS provide exactly 5 short, contextual follow-up suggestions. Each must be a concise prompt (under 60 characters) that naturally continues the conversation. They should be relevant to both the user's question and your response. Never generic filler.
2. "questions" — ONLY include when you genuinely need clarification or preferences from the user before giving a better answer. When included, each question object has:
   - "question": a short, clear question (under 80 characters)
   - "multiSelect": boolean (optional, default false). Set to true ONLY when the user can meaningfully choose more than one option at once (e.g. "Which topics interest you?"). Leave false or omit for single-choice questions (e.g. "What's your experience level?")
   - "options": 3 to 5 short option strings (under 40 characters each) representing the most likely answers
3. If you do not need to ask questions, set "questions" to an empty array [].
4. The entire block must be valid JSON inside the <araviel_meta> tags.
5. Do NOT reference this metadata block in your visible response.
6. Follow-ups should feel like natural next steps, not repetitions of what was already said.
7. IMPORTANT — When you have questions or choices for the user (e.g. "Would you like me to...", "Do you prefer...", "Which option..."), you MUST:
   - Put them ONLY in the "questions" array inside the metadata block.
   - Do NOT write the questions, choices, options, or bullet-point lists of choices in your visible response text.
   - Your visible response should end BEFORE any questions. Just provide your answer/analysis, then put questions exclusively in the metadata.
   - For example, instead of writing "Would you like me to: (a) do X, (b) do Y, (c) do Z?" in the response, just end the response after your analysis and put {"question":"What would you like next?","options":["Do X","Do Y","Do Z","Do W","Do V"]} in the questions array.

Example with questions (note: the visible response does NOT contain the questions):
<araviel_meta>
{"followUps":["Compare with alternatives","Show a practical example","Explain the trade-offs","See benchmarks","Read case studies"],"questions":[{"question":"What's your experience level?","options":["Beginner","Intermediate","Advanced","Expert","Just browsing"]},{"question":"Which languages interest you?","options":["Python","JavaScript","TypeScript","Go","Rust"],"multiSelect":true}]}
</araviel_meta>

Example without questions:
<araviel_meta>
{"followUps":["Dive deeper into performance","See real-world use cases","Explore related patterns","Check compatibility details","Learn advanced techniques"],"questions":[]}
</araviel_meta>`;
}

export function getDeepResearchInstructions(): string {
  return `\n\n--- Deep Research Mode ---
You are operating in deep research mode via Araviel. In this mode you have access to web search and should conduct thorough, multi-source research to provide comprehensive answers.

## Research Guidelines
- **Be exhaustive**: Search broadly across multiple authoritative sources. Cross-reference claims between sources before presenting them as facts.
- **Cite everything**: Every factual claim must be backed by a source. Use inline citations throughout your response, not just at the end.
- **Stay current**: Prioritise the most recent and up-to-date information available. Note when information may be outdated.
- **Evaluate credibility**: Prefer primary sources, peer-reviewed research, official documentation, and established publications over informal or unverified sources.
- **Handle ambiguity**: When sources conflict, present the differing perspectives transparently with their respective sources. Do not silently pick one.
- **Structure for depth**: Organise findings with clear headings and sections. Start with a concise executive summary, then provide detailed analysis.
- **Scope appropriately**: Cover the topic comprehensively — consider historical context, current state, future outlook, related considerations, and practical implications where relevant.
- **Be precise**: Include specific data points, statistics, dates, and names where available. Avoid vague generalisations when concrete information exists.

## Response Format
1. Begin with a brief **summary** (2-3 sentences) that directly answers the core question.
2. Follow with detailed, well-structured sections covering all relevant aspects.
3. End with key takeaways or actionable insights where appropriate.
4. Every response should read like a well-researched briefing document — thorough, balanced, and immediately useful.`;
}

export async function getProjectInstructionsForConversation(
  conversationId: string
): Promise<string | null> {
  const supabase = getSupabase();

  const { data: conversation, error: convError } = await supabase
    .from("conversations")
    .select("project_id")
    .eq("id", conversationId)
    .is("deleted_at", null)
    .single();

  if (convError || !conversation?.project_id) {
    return null;
  }

  const { data: project, error: projError } = await supabase
    .from("projects")
    .select("instructions")
    .eq("id", conversation.project_id)
    .single();

  if (projError || !project?.instructions) {
    return null;
  }

  return project.instructions;
}

export function resolveWebSearch(
  userWebSearch: boolean | undefined,
  analysis: ADEResponse["analysis"],
  prompt?: string,
  previousAssistantUsedSearch?: boolean
): { shouldUseWebSearch: boolean; webSearchAutoDetected: boolean } {
  // User explicitly toggled web search on
  if (userWebSearch === true) {
    return { shouldUseWebSearch: true, webSearchAutoDetected: false };
  }

  // User explicitly toggled web search off
  if (userWebSearch === false) {
    return { shouldUseWebSearch: false, webSearchAutoDetected: false };
  }

  // Auto mode: trust ADE's webSearchRequired flag, fall back to intent-based
  // detection, then a prompt-level frontstop for real-time tells that ADE
  // may misclassify (weather, news, prices, scores), and finally inherit
  // from the previous assistant turn for short follow-ups in a conversation
  // that's already been about live data. Top-tier products never blindly
  // trust the router for obvious time-sensitive queries.
  const adeRecommends = analysis.webSearchRequired ?? detectWebSearchFromIntent(analysis);
  const promptIsTimeSensitive = prompt ? detectTimeSensitivePrompt(prompt) : false;
  const inheritsFromPrevious =
    previousAssistantUsedSearch === true && isLikelyFollowUp(prompt);
  const autoDetected = adeRecommends || promptIsTimeSensitive || inheritsFromPrevious;
  return { shouldUseWebSearch: autoDetected, webSearchAutoDetected: autoDetected };
}

function detectWebSearchFromIntent(analysis: ADEResponse["analysis"]): boolean {
  const searchIntents = new Set([
    "research",
    "current_events",
    "news",
    "factual_lookup",
    "fact_checking",
    "information_retrieval",
  ]);
  return searchIntents.has(analysis.intent);
}

// High-precision patterns for prompts that overwhelmingly need live data.
// Kept narrow on purpose — false positives just pay an unneeded search,
// but missing weather/news/prices means the model fabricates or refuses.
const TIME_SENSITIVE_PATTERNS: RegExp[] = [
  // Weather
  /\bweather\b/i,
  /\bforecast\b/i,
  /\btemperature\s+(?:in|for|today|tonight|now|right\s+now|currently)\b/i,

  // News / current events
  /\b(?:breaking|latest|today'?s?)\s+news\b/i,
  /\bnews\s+(?:today|right\s+now|now|currently)\b/i,
  /\bheadlines?\b/i,

  // Finance
  /\b(?:stock|share)\s+price\b/i,
  /\bexchange\s+rate\b/i,
  /\bprice\s+of\s+(?:bitcoin|ethereum|btc|eth|sol|doge|crypto)\b/i,
  /\b(?:bitcoin|ethereum|btc|eth)\s+price\b/i,
  /\bcrypto(?:currency)?\s+price\b/i,

  // Sports / live results
  /\bwho\s+(?:won|is\s+winning|'s\s+winning)\b/i,
  /\b(?:final|live|current)\s+score\b/i,
];

/**
 * Heuristic that catches real-time prompts ADE may misclassify.
 *
 * Long prompts and prompts containing fenced code are skipped so a
 * coding question about a weather app or a finance dashboard tutorial
 * doesn't trigger an unwanted search.
 */
export function detectTimeSensitivePrompt(prompt: string): boolean {
  if (!prompt) return false;
  const trimmed = prompt.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return false;
  if (trimmed.includes("```")) return false;
  return TIME_SENSITIVE_PATTERNS.some((re) => re.test(trimmed));
}

// Short, fenced-code-free prompts are almost always follow-up questions
// that belong to the conversation's current topic. Longer prompts tend to
// be self-contained new requests and should be classified on their own
// merits — we don't want a 400-character coding question to inherit web
// search from an earlier weather chat.
function isLikelyFollowUp(prompt: string | undefined): boolean {
  if (!prompt) return false;
  const trimmed = prompt.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return false;
  if (trimmed.includes("```")) return false;
  return true;
}

export function shouldEnableThinking(analysis: ADEResponse["analysis"]): boolean {
  return analysis.complexity === "demanding";
}

/**
 * User-selected reasoning preferences from the frontend "Research" dropdown.
 * Each flag is provider-scoped: it only takes effect when the active model
 * belongs to the matching provider.
 */
export interface ThinkingPreference {
  extendedThinking?: boolean;
  deepResearch?: boolean;
  googleThinking?: boolean;
}

/**
 * Provider that each reasoning toggle targets. Returns null when no toggle is
 * set — callers should leave model selection alone in that case.
 */
export function getPreferredThinkingProvider(
  preference: ThinkingPreference
): "anthropic" | "openai" | "google" | null {
  if (preference.extendedThinking) return "anthropic";
  if (preference.deepResearch) return "openai";
  if (preference.googleThinking) return "google";
  return null;
}

/**
 * Steer model selection toward the provider implied by the user's reasoning
 * toggle. ADE picks models based on prompt content alone — it has no
 * visibility into the dropdown — so a user clicking "Extended Thinking" on a
 * research-leaning prompt could otherwise end up on Perplexity Sonar instead
 * of Claude. This override runs after ADE and before the routing event so the
 * model the client sees is the model that actually answers.
 *
 * Selection rules, in order:
 *   1. If the user manually selected a model, do nothing — manual choice
 *      always wins over the dropdown.
 *   2. If no toggle is set, do nothing.
 *   3. If the requested provider isn't configured server-side, do nothing
 *      (we'd just fail when trying to call it).
 *   4. If ADE's primary already supports the toggle's thinking semantics,
 *      keep it.
 *   5. Otherwise, swap to the first ADE backup that does — ADE already
 *      vetted the backups as suitable for the prompt.
 *   6. If neither the primary nor any backup supports the toggle, fall back
 *      to a known thinking-capable default for the provider. We never swap
 *      to a same-provider-but-non-thinking-capable model, since that would
 *      silently downgrade the toggle (the provider implementation only
 *      sends thinking parameters for capable models).
 */
export function applyThinkingProviderOverride(
  resolved: { model: ModelInfo; backupModels: ModelInfo[]; isManualSelection: boolean },
  preference: ThinkingPreference,
  availableProviders: ReadonlyArray<string>
): { model: ModelInfo; backupModels: ModelInfo[]; isManualSelection: boolean; overriddenForProvider?: string } {
  if (resolved.isManualSelection) return resolved;

  const target = getPreferredThinkingProvider(preference);
  if (!target) return resolved;
  if (!availableProviders.includes(target)) return resolved;

  if (
    resolved.model.provider === target &&
    isPreferredThinkingModel(resolved.model.id, target)
  ) {
    return resolved;
  }

  const preferredBackup = resolved.backupModels.find(
    (m) => m.provider === target && isPreferredThinkingModel(m.id, target)
  );
  if (preferredBackup) {
    return {
      model: preferredBackup,
      backupModels: [
        resolved.model,
        ...resolved.backupModels.filter((m) => m.id !== preferredBackup.id),
      ],
      isManualSelection: resolved.isManualSelection,
      overriddenForProvider: target,
    };
  }

  const fallback = DEFAULT_THINKING_MODELS[target];
  const overrideModel: ModelInfo = {
    id: fallback.id,
    name: fallback.name,
    provider: target,
    score: 0,
    reasoning: "Selected to match the user's reasoning-mode preference",
  };
  return {
    model: overrideModel,
    backupModels: [resolved.model, ...resolved.backupModels],
    isManualSelection: resolved.isManualSelection,
    overriddenForProvider: target,
  };
}

/**
 * Resolve whether thinking should be enabled for this request.
 *
 * Precedence: an explicit, provider-matching user toggle wins over ADE; when
 * the user has expressed no matching preference, fall back to the ADE
 * complexity classifier so existing auto-routing behavior is preserved.
 *
 * Toggles that target a different provider than the active model are silently
 * ignored — the dropdown is provider-aware in the UI but the backend treats
 * mismatches as a no-op so we never send a flag the provider doesn't honor.
 */
export function resolveThinking(
  analysis: ADEResponse["analysis"],
  modelProvider: string,
  preference: ThinkingPreference
): boolean {
  if (preference.extendedThinking && modelProvider === "anthropic") return true;
  if (preference.deepResearch && modelProvider === "openai") return true;
  if (preference.googleThinking && modelProvider === "google") return true;
  return shouldEnableThinking(analysis);
}

/** Fast keyword check to detect if user is requesting a file download/export. */
const FILE_INTENT_PATTERNS = /\b(download\s+as|export\s+(?:to|as|it)|save\s+(?:as|to|this)|give\s+me\s+(?:a|the)\s+(?:pdf|docx?|xlsx?|csv|pptx?|word|excel|powerpoint|spreadsheet|presentation|text\s+file)|create\s+(?:a|the)\s+(?:pdf|docx?|xlsx?|csv|pptx?|word|excel|powerpoint|spreadsheet|presentation)|generate\s+(?:a|the)\s+(?:file|pdf|docx?|xlsx?|csv|pptx?|word|excel|powerpoint|spreadsheet|presentation)|as\s+(?:a\s+)?(?:pdf|docx?|xlsx?|csv|pptx?)\b|\.pdf\b|\.docx?\b|\.xlsx?\b|\.csv\b|\.pptx?\b|i\s+need\s+(?:a|the)\s+(?:pdf|word|excel|spreadsheet|powerpoint|presentation|file)|convert\s+(?:to|this|it)\s+(?:to\s+)?(?:pdf|word|excel|csv|powerpoint)|make\s+(?:a|me\s+a)\s+(?:pdf|word|excel|spreadsheet|csv|powerpoint|presentation))\b/i;

export function detectFileIntent(message: string): boolean {
  return FILE_INTENT_PATTERNS.test(message);
}

export function findSupportedBackup(
  backupModels: ModelInfo[]
): ModelInfo | undefined {
  return backupModels.find((m) => SUPPORTED_PROVIDERS.has(m.provider));
}

/**
 * Outcome of choosing a backup model on the chat retry path. Carries enough
 * context for the caller to emit a truthful PROVIDER_RETRY notification —
 * particularly to disclose when the user's active reasoning toggle could not
 * be honored on the backup.
 */
export interface BackupChoice {
  readonly backup: ModelInfo;
  /**
   * False only when a reasoning toggle was set but no thinking-capable
   * backup from the matching provider was available, so we fell through to
   * a different provider and the toggle effectively gets dropped for this
   * retry attempt.
   */
  readonly modeHonored: boolean;
  /**
   * The reasoning toggle's target provider when `modeHonored` is false,
   * letting the caller name the specific mode being downgraded. Null when
   * either no toggle was set or the toggle was honored normally.
   */
  readonly downgradedFrom: ThinkingTargetProvider | null;
}

/**
 * Pick a backup model on the chat retry path while honoring the user's
 * reasoning toggle when possible. The existing primary path already
 * surfaces toggle preference via applyThinkingProviderOverride — this is the
 * retry-side companion so a failed primary doesn't silently drop the mode.
 *
 * Selection order:
 *   1. If no toggle is set, or the toggle's provider isn't configured —
 *      same behavior as findSupportedBackup (first supported backup).
 *   2. Prefer a backup that is both same-provider as the toggle target AND
 *      thinking-capable for that toggle. Toggle is honored.
 *   3. Fall through to the first supported backup, with the toggle reported
 *      as downgraded so the caller can disclose it to the user.
 *
 * We deliberately do not synthesize the DEFAULT_THINKING_MODELS default on
 * retry — the override path already gets one shot at that model. Retrying
 * the same synthesized model after a provider-wide outage would stack
 * identical failures and burn latency for no gain.
 */
export function findThinkingAwareBackup(
  backupModels: ModelInfo[],
  preference: ThinkingPreference,
  availableProviders: ReadonlyArray<string>
): BackupChoice | undefined {
  const target = getPreferredThinkingProvider(preference);

  if (!target || !availableProviders.includes(target)) {
    const fallback = findSupportedBackup(backupModels);
    return fallback
      ? { backup: fallback, modeHonored: true, downgradedFrom: null }
      : undefined;
  }

  const honored = backupModels.find(
    (m) =>
      SUPPORTED_PROVIDERS.has(m.provider) &&
      m.provider === target &&
      isPreferredThinkingModel(m.id, target)
  );
  if (honored) {
    return { backup: honored, modeHonored: true, downgradedFrom: null };
  }

  const downgrade = findSupportedBackup(backupModels);
  return downgrade
    ? { backup: downgrade, modeHonored: false, downgradedFrom: target }
    : undefined;
}

export async function createSubConversation(
  conversationId: string,
  parentMessageId: string,
  highlightedText: string
): Promise<DBSubConversation> {
  const supabase = getSupabase();
  const id = randomUUID();
  const now = new Date().toISOString();

  // Verify parent message exists and belongs to the conversation
  const { data: msg, error: msgError } = await supabase
    .from("messages")
    .select("id")
    .eq("id", parentMessageId)
    .eq("conversation_id", conversationId)
    .single();

  if (msgError || !msg) {
    throw new Error("Parent message not found in this conversation");
  }

  const { error } = await supabase.from("sub_conversations").insert({
    id,
    conversation_id: conversationId,
    parent_message_id: parentMessageId,
    highlighted_text: highlightedText,
    created_at: now,
    updated_at: now,
  });

  if (error) {
    throw new Error(`Failed to create sub-conversation: ${error.message}`);
  }

  return {
    id,
    conversation_id: conversationId,
    parent_message_id: parentMessageId,
    highlighted_text: highlightedText,
    is_starred: false,
    is_archived: false,
    is_reported: false,
    created_at: now,
    updated_at: now,
  };
}

export async function getSubConversations(
  parentMessageId: string
): Promise<DBSubConversation[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("sub_conversations")
    .select("*")
    .eq("parent_message_id", parentMessageId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch sub-conversations: ${error.message}`);
  }

  return (data ?? []) as DBSubConversation[];
}

export async function validateSubConversation(
  subConversationId: string
): Promise<{ conversationId: string }> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from("sub_conversations")
    .select("conversation_id")
    .eq("id", subConversationId)
    .single();

  if (error || !data) {
    throw new Error(`Sub-conversation not found: ${subConversationId}`);
  }

  return { conversationId: data.conversation_id };
}

export { randomUUID };

export type { DBConversation, DBMessage, DBSubConversation };
