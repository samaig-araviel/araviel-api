import OpenAI from "openai";
import { logger } from "@/lib/logger";
import type { ConversationMessage } from "@/lib/types";

const SYNTHESIS_MODEL = "gpt-4o-mini";
const SYNTHESIS_TIMEOUT_MS = 8000;
const HISTORY_WINDOW = 10;
const MAX_OUTPUT_TOKENS = 320;
const TEMPERATURE = 0.4;

const SYSTEM_PROMPT = `You compose prompts for an image-generation model.

The user has been chatting and now wants an image. Read their most recent request and the prior conversation, then write ONE detailed image-generation prompt describing what should be drawn.

Rules:
- Output ONLY the prompt itself. No preamble, no "Sure, here is...", no markdown, no quotes.
- Focus on visual content: subject, style, composition, mood, palette, lighting, framing, format.
- If the user's request is short or refers to prior context ("generate it", "make the image", "the flyer"), pull the relevant visual details from the conversation.
- If the user's request is already a complete standalone prompt, polish it without injecting unrelated context.
- 40 to 160 words. Single paragraph. No lists, no headings.`;

let cachedClient: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  cachedClient = new OpenAI({ apiKey });
  return cachedClient;
}

function formatHistoryForSynthesis(history: ConversationMessage[]): string {
  return history
    .slice(-HISTORY_WINDOW)
    .map((msg) => {
      const content =
        msg.content?.trim() ||
        (msg.images && msg.images.length > 0
          ? `[${msg.images.length} attached image${msg.images.length > 1 ? "s" : ""}]`
          : "");
      return `${msg.role.toUpperCase()}: ${content}`;
    })
    .filter((line) => !line.endsWith(": "))
    .join("\n\n");
}

export interface SynthesizeImagePromptParams {
  history: ConversationMessage[];
  userMessage: string;
  client?: Pick<OpenAI, "chat">;
}

export async function synthesizeImagePrompt({
  history,
  userMessage,
  client: clientOverride,
}: SynthesizeImagePromptParams): Promise<string> {
  const fallback = userMessage.trim() || userMessage;
  const client = clientOverride ?? getClient();
  if (!client) return fallback;

  const conversationText = formatHistoryForSynthesis(history);
  const userBlock = conversationText
    ? `Conversation so far:\n\n${conversationText}\n\nUser's new request: ${userMessage}\n\nWrite the image-generation prompt.`
    : `User's request: ${userMessage}\n\nWrite the image-generation prompt.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNTHESIS_TIMEOUT_MS);

  try {
    const completion = await client.chat.completions.create(
      {
        model: SYNTHESIS_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userBlock },
        ],
        temperature: TEMPERATURE,
        max_tokens: MAX_OUTPUT_TOKENS,
      },
      { signal: controller.signal }
    );

    const synthesized = completion.choices[0]?.message?.content?.trim();
    if (synthesized && synthesized.length > 0) return synthesized;
    return fallback;
  } catch (err) {
    logger.warn("Image prompt synthesis failed; falling back to user message", {
      route: "chat",
      subRoute: "image-prompt-synthesis",
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
