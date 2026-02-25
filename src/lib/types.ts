export type SupportedProvider = "openai" | "anthropic" | "google" | "perplexity";

export const SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set<SupportedProvider>([
  "openai",
  "anthropic",
  "google",
  "perplexity",
]);

export interface ChatRequest {
  conversationId?: string;
  subConversationId?: string;
  message: string;
  userTier?: string;
  modality?: string;
  selectedModelId?: string;
  webSearch?: boolean;
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
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  webSearchRequests?: number;
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
  | "done"
  | "error";

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
  created_at: string;
  updated_at: string;
}
