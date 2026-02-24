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

export function validateChatRequest(body: unknown): ChatRequest {
  if (!body || typeof body !== "object") {
    throw new Error("Request body is required");
  }

  const req = body as Record<string, unknown>;

  if (!req.message || typeof req.message !== "string" || req.message.trim() === "") {
    throw new Error("message is required and must be a non-empty string");
  }

  return {
    conversationId: typeof req.conversationId === "string" ? req.conversationId : undefined,
    subConversationId: typeof req.subConversationId === "string" ? req.subConversationId : undefined,
    message: req.message.trim(),
    userTier: typeof req.userTier === "string" ? req.userTier : "free",
    modality: typeof req.modality === "string" ? req.modality : "text",
    selectedModelId: typeof req.selectedModelId === "string" ? req.selectedModelId : undefined,
  };
}

export async function getOrCreateConversation(
  conversationId: string | undefined,
  messagePreview: string
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

  const { error } = await supabase.from("conversations").insert({
    id,
    title,
    created_at: now,
    updated_at: now,
  });

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
  if (modelId.startsWith("gpt") || modelId.startsWith("o3") || modelId.startsWith("o4")) return "openai";
  if (modelId.startsWith("gemini")) return "google";
  if (modelId.startsWith("sonar")) return "perplexity";
  return "openai";
}

export function buildSystemPrompt(): string {
  return [
    "You are a helpful AI assistant powered by Araviel, an intelligent AI platform.",
    "Provide clear, accurate, and well-structured responses.",
    "When appropriate, use markdown formatting for better readability.",
    "Be concise but thorough. If you are unsure about something, say so.",
  ].join(" ");
}

export function shouldEnableWebSearch(analysis: ADEResponse["analysis"]): boolean {
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
