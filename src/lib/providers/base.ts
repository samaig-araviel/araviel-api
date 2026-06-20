import type { ConversationMessage, Citation, SystemPromptParts, TokenUsage } from "@/lib/types";

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
  /**
   * Optional structured system prompt. When set, caching-aware providers
   * use this instead of `systemPrompt` to place cache_control on the
   * stable prefix. Other providers ignore it.
   */
  systemPromptParts?: SystemPromptParts;
  messages: ConversationMessage[];
  enableThinking: boolean;
  enableWebSearch: boolean;
  enableImageGeneration?: boolean;
  /**
   * Requested image quality for native image generation models. Providers
   * map this to their own size/resolution parameter (e.g. Gemini's
   * `imageConfig.imageSize`). Ignored by text-only models.
   */
  imageQuality?: "standard" | "hd" | "ultra";
}

export interface AIProvider {
  stream(config: ProviderConfig): AsyncGenerator<ProviderStreamEvent>;
}
