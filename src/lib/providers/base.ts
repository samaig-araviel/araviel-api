import type { ConversationMessage, Citation, TokenUsage } from "@/lib/types";

export interface ProviderStreamEvent {
  type: "delta" | "thinking" | "citations" | "tool_use" | "image_generation" | "research_status" | "done" | "error";
  content?: string;
  citations?: Citation[];
  tool?: string;
  status?: string;
  usage?: TokenUsage;
  webSearchUsed?: boolean;
  error?: string;
  imageUrl?: string;
  /** Deep research progress fields */
  researchStatus?: string;
  researchSources?: number;
  researchActions?: Array<{ type: string; query?: string; url?: string }>;
}

export interface ProviderConfig {
  modelId: string;
  systemPrompt: string;
  messages: ConversationMessage[];
  enableThinking: boolean;
  enableWebSearch: boolean;
  enableImageGeneration?: boolean;
}

export interface AIProvider {
  stream(config: ProviderConfig): AsyncGenerator<ProviderStreamEvent>;
}
