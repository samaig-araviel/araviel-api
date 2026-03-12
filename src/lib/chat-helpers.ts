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
  ModelInfo,
  TokenUsage,
} from "@/lib/types";
import { SUPPORTED_PROVIDERS } from "@/lib/types";
import { getChartInstructions } from "@/lib/prompts/chart-instructions";
import { getMessages as getImportedMessages } from "@/lib/imported-conversations";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateChatRequest(body: unknown): ChatRequest {
  if (!body || typeof body !== "object") {
    throw new Error("Request body is required");
  }

  const req = body as Record<string, unknown>;

  if (!req.message || typeof req.message !== "string" || req.message.trim() === "") {
    throw new Error("message is required and must be a non-empty string");
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
    modality: typeof req.modality === "string" ? req.modality : "text",
    selectedModelId: typeof req.selectedModelId === "string" ? req.selectedModelId : undefined,
    webSearch: typeof req.webSearch === "boolean" ? req.webSearch : undefined,
    tone: typeof req.tone === "string" ? req.tone : undefined,
    mood: typeof req.mood === "string" ? req.mood : undefined,
    autoStrategy: typeof req.autoStrategy === "string" ? req.autoStrategy : undefined,
    weather: typeof req.weather === "string" ? req.weather : undefined,
    conversationHasImages: typeof req.conversationHasImages === "boolean" ? req.conversationHasImages : undefined,
  };
}

export async function getOrCreateConversation(
  conversationId: string | undefined,
  messagePreview: string,
  projectId?: string
): Promise<string> {
  const supabase = getSupabase();

  if (conversationId) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .single();

    if (error || !data) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    return conversationId;
  }

  const id = randomUUID();
  const title = messagePreview.slice(0, 50) + (messagePreview.length > 50 ? "..." : "");
  const now = new Date().toISOString();

  const row: Record<string, unknown> = {
    id,
    title,
    created_at: now,
    updated_at: now,
  };

  if (projectId) {
    row.project_id = projectId;
  }

  const { error } = await supabase.from("conversations").insert(row);

  if (error) {
    throw new Error(`Failed to create conversation: ${error.message}`);
  }

  return id;
}

export async function saveUserMessage(
  conversationId: string,
  content: string,
  subConversationId?: string
): Promise<string> {
  const supabase = getSupabase();
  const id = randomUUID();

  const { error } = await supabase.from("messages").insert({
    id,
    conversation_id: conversationId,
    sub_conversation_id: subConversationId ?? null,
    role: "user",
    content,
    created_at: new Date().toISOString(),
  });

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
    .eq("id", conversationId);
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
      .select("role, content")
      .eq("sub_conversation_id", subConversationId)
      .order("created_at", { ascending: true })
      .limit(20);

    if (error) {
      throw new Error(`Failed to fetch sub-conversation history: ${error.message}`);
    }

    const messages = (data ?? []).map((msg: Pick<DBMessage, "role" | "content">) => ({
      role: msg.role as ConversationMessage["role"],
      content: msg.content,
    }));

    return [...contextMessages, ...messages];
  }

  // Main conversation: exclude sub-conversation messages
  const { data, error } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .is("sub_conversation_id", null)
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    throw new Error(`Failed to fetch conversation history: ${error.message}`);
  }

  return (data ?? []).map((msg: Pick<DBMessage, "role" | "content">) => ({
    role: msg.role as ConversationMessage["role"],
    content: msg.content,
  }));
}

/**
 * Fetch messages from an imported conversation and convert them to
 * ConversationMessage format suitable for prepending to native history.
 */
export async function fetchImportedConversationHistory(
  importedConversationId: string
): Promise<ConversationMessage[]> {
  const messages = await getImportedMessages(importedConversationId);

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
  if (modelId.startsWith("gpt") || modelId.startsWith("o3") || modelId.startsWith("o4") || modelId.startsWith("dall-e") || modelId.startsWith("gpt-image")) return "openai";
  if (modelId.startsWith("gemini") || modelId.startsWith("imagen")) return "google";
  if (modelId.startsWith("sonar")) return "perplexity";
  if (modelId.startsWith("stable-diffusion")) return "stability";
  return "openai";
}

/** Dedicated image generation models that use separate image APIs (not chat/streaming). */
const DEDICATED_IMAGE_MODELS = new Set([
  "dall-e-3",
  "gpt-image-1",
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
 * OpenAI: image_generation tool in Responses API (GPT-4o series, GPT-4.1 series, o-series).
 * Google: responseModalities for Gemini models.
 * Models NOT in this set should fall back to a dedicated image model.
 */
const NATIVE_IMAGE_GEN_MODELS = new Set([
  // OpenAI — image_generation tool in Responses API
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "o3",
  "o3-pro",
  "o4-mini",
  // Google — responseModalities
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
]);

/**
 * Check whether a model can generate images — either as a dedicated image model
 * or as a chat model with verified native image generation support.
 */
export function canModelGenerateImages(modelId: string): boolean {
  return DEDICATED_IMAGE_MODELS.has(modelId) || NATIVE_IMAGE_GEN_MODELS.has(modelId);
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
      { id: "gpt-image-1.5", name: "GPT Image 1.5", provider: "OpenAI" },
      { id: "gpt-image-1-mini", name: "GPT Image 1 Mini", provider: "OpenAI" },
      { id: "dall-e-3", name: "DALL-E 3", provider: "OpenAI" },
      { id: "imagen-4", name: "Imagen 4", provider: "Google" },
      { id: "stable-diffusion-3.5", name: "Stable Diffusion 3.5", provider: "Stability AI" },
    ],
    nativeChat: [
      { id: "gpt-4o", name: "GPT-4o", provider: "OpenAI" },
      { id: "gpt-4.1", name: "GPT-4.1", provider: "OpenAI" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "Google" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google" },
    ],
  };
}

export function buildSystemPrompt(projectInstructions?: string): string {
  const basePrompt = [
    "You are a helpful AI assistant powered by Araviel, an intelligent AI platform.",
    "Provide clear, accurate, and well-structured responses.",
    "When appropriate, use markdown formatting for better readability.",
    "Be concise but thorough. If you are unsure about something, say so.",
    "Do not use emojis in your responses. Keep your tone professional and clean.",
  ].join(" ");

  let prompt = `${basePrompt}\n\n${getChartInstructions()}`;

  if (projectInstructions && projectInstructions.trim()) {
    prompt += `\n\n--- Project Instructions ---\nThe following instructions were set by the user for this project. Follow them for all responses in this conversation:\n\n${projectInstructions}`;
  }

  return prompt;
}

export async function getProjectInstructionsForConversation(
  conversationId: string
): Promise<string | null> {
  const supabase = getSupabase();

  const { data: conversation, error: convError } = await supabase
    .from("conversations")
    .select("project_id")
    .eq("id", conversationId)
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
  analysis: ADEResponse["analysis"]
): { shouldUseWebSearch: boolean; webSearchAutoDetected: boolean } {
  // User explicitly toggled web search on
  if (userWebSearch === true) {
    return { shouldUseWebSearch: true, webSearchAutoDetected: false };
  }

  // User explicitly toggled web search off
  if (userWebSearch === false) {
    return { shouldUseWebSearch: false, webSearchAutoDetected: false };
  }

  // Auto mode: check ADE's webSearchRequired, fall back to intent-based detection
  const adeRecommends = analysis.webSearchRequired ?? detectWebSearchFromIntent(analysis);
  return { shouldUseWebSearch: adeRecommends, webSearchAutoDetected: adeRecommends };
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

export function shouldEnableThinking(analysis: ADEResponse["analysis"]): boolean {
  return analysis.complexity === "demanding";
}

export function findSupportedBackup(
  backupModels: ModelInfo[]
): ModelInfo | undefined {
  return backupModels.find((m) => SUPPORTED_PROVIDERS.has(m.provider));
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
