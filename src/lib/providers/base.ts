import type { ConversationMessage, Citation, TokenUsage } from "@/lib/types";

export interface ProviderStreamEvent {
  type: "delta" | "thinking" | "citations" | "tool_use" | "done" | "error";
  content?: string;
  citations?: Citation[];
  tool?: string;
  status?: string;
  usage?: TokenUsage;
  webSearchUsed?: boolean;
  error?: string;
}

export interface ProviderConfig {
  modelId: string;
  systemPrompt: string;
  messages: ConversationMessage[];
  enableThinking: boolean;
  enableWebSearch: boolean;
}

export interface AIProvider {
  stream(config: ProviderConfig): AsyncGenerator<ProviderStreamEvent>;
}
