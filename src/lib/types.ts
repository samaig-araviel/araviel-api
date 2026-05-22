export type SupportedProvider = "openai" | "anthropic" | "google" | "perplexity" | "stability";

export const SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set<SupportedProvider>([
  "openai",
  "anthropic",
  "google",
  "perplexity",
  "stability",
]);

export interface ImageAttachment {
  dataUri: string;
  mimeType: string;
  fileName?: string;
}

export interface ChatRequest {
  conversationId?: string;
  subConversationId?: string;
  importedConversationId?: string;
  projectId?: string;
  message: string;
  userTier?: string;
  userId?: string;
  modality?: string;
  imageQuality?: "standard" | "hd" | "ultra";
  selectedModelId?: string;
  webSearch?: boolean;
  tone?: string;
  mood?: string;
  autoStrategy?: string;
  weather?: string;
  conversationHasImages?: boolean;
  images?: ImageAttachment[];
  /**
   * User-selected reasoning mode toggles. Each flag corresponds to one entry in
   * the frontend "Research" dropdown and only takes effect when the active
   * model belongs to the matching provider. When set, the toggle overrides the
   * ADE complexity classifier for the thinking decision; when absent, the
   * classifier's default applies.
   */
  extendedThinking?: boolean;
  deepResearch?: boolean;
  googleThinking?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  score: number;
  reasoning: string;
}

export interface ADEAnalysis {
  intent: string;
  domain: string;
  complexity: string;
  tone: string;
  modality: string;
  keywords: string[];
  humanContextUsed: boolean;
  webSearchRequired?: boolean;
}

export interface ADEReasoningFactor {
  name: string;
  impact: "positive" | "neutral" | "negative";
  weight: number;
  detail: string;
}

export interface ADEModelResult {
  id: string;
  name: string;
  provider: string;
  score: number;
  reasoning: {
    summary: string;
    factors: ADEReasoningFactor[];
  };
}

export interface ADEUpgradeHint {
  recommendedModel: {
    id: string;
    name: string;
    provider: string;
  };
  targetTier: 'lite' | 'pro';
  reason: string;
  scoreDifference: number;
}

export interface ADEProviderHint {
  recommendedModel: {
    id: string;
    name: string;
    provider: string;
  };
  reason: string;
  scoreDifference: number;
}

export interface ADEFallback {
  supported: boolean;
  category: string;
  message: string;
  suggestedPlatforms: string[];
}

export interface ADEResponse {
  decisionId: string;
  primaryModel: ADEModelResult;
  backupModels: ADEModelResult[];
  confidence: number;
  analysis: ADEAnalysis;
  timing: {
    totalMs: number;
    analysisMs: number;
    scoringMs: number;
    selectionMs: number;
  };
  upgradeHint?: ADEUpgradeHint | null;
  providerHint?: ADEProviderHint | null;
  fallback?: ADEFallback | null;
}

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  images?: ImageAttachment[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Tokens served from the provider's prompt cache (cheap reads). */
  cachedTokens: number;
  /** Tokens written into the provider's prompt cache on this request (premium writes). */
  cacheCreationTokens?: number;
  webSearchRequests?: number;
}

/**
 * Structured form of the system prompt for providers that support
 * prefix-based prompt caching (currently Anthropic). `stable` holds the
 * static instructions identical across requests and should be marked
 * as a cache breakpoint. `variable` holds the per-request, per-user,
 * or per-project content that sits after the breakpoint.
 *
 * Providers that don't support caching ignore the structured form and
 * use the existing `systemPrompt` string instead.
 */
export interface SystemPromptParts {
  stable: string;
  variable?: string;
}

export interface Citation {
  url: string;
  title: string;
  snippet?: string;
}

export type SSEEventType =
  | "routing"
  | "thinking"
  | "delta"
  | "citations"
  | "tool_use"
  | "image_generation"
  | "research_status"
  | "followups"
  | "questions"
  | "title"
  | "done"
  | "error";

export interface FollowUpQuestion {
  question: string;
  options: string[];
  multiSelect?: boolean;
}

export interface SSEFollowUpsData {
  suggestions: string[];
}

export interface SSEQuestionsData {
  questions: FollowUpQuestion[];
}

export interface SSERoutingData {
  conversationId: string;
  messageId: string;
  model: ModelInfo;
  backupModels: ModelInfo[];
  analysis: {
    intent: string;
    domain: string;
    complexity: string;
  };
  confidence: number;
  adeLatencyMs: number;
  isManualSelection: boolean;
  upgradeHint: ADEUpgradeHint | null;
  providerHint: ADEProviderHint | null;
  webSearchUsed: boolean;
  webSearchAutoDetected: boolean;
  showThinking: boolean;
}

export interface SSEDoneData {
  messageId: string;
  conversationId: string;
  usage: TokenUsage;
  latencyMs: number;
  adeLatencyMs: number;
}

export interface StreamEvent {
  type: SSEEventType;
  data: Record<string, unknown>;
}

export interface DBConversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface DBMessage {
  id: string;
  conversation_id: string;
  sub_conversation_id: string | null;
  role: string;
  content: string;
  model_used: Record<string, unknown> | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  tokens_cached: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  ade_latency_ms: number | null;
  extended_data: Record<string, unknown> | null;
  tool_calls: unknown | null;
  tool_call_id: string | null;
  attachments: unknown | null;
  created_at: string;
}

export interface DBSubConversation {
  id: string;
  conversation_id: string;
  parent_message_id: string;
  highlighted_text: string;
  is_starred: boolean;
  is_archived: boolean;
  is_reported: boolean;
  created_at: string;
  updated_at: string;
}
