import OpenAI from "openai";
import { logger } from "@/lib/logger";
import type { ConversationMessage } from "@/lib/types";

const SYNTHESIS_MODEL = "gpt-4o-mini";
const SYNTHESIS_TIMEOUT_MS = 8000;
const HISTORY_WINDOW = 10;
const MAX_OUTPUT_TOKENS = 400;
const TEMPERATURE = 0.4;

/**
 * Aspect ratios the synthesizer is allowed to return. These map cleanly onto
 * both Gemini's `imageConfig.aspectRatio` enum and OpenAI's gpt-image-2 size
 * grid (see `aspectRatioToOpenAISize`).
 */
export type ImageAspectRatio =
  | "1:1"
  | "16:9"
  | "9:16"
  | "4:3"
  | "3:4"
  | "21:9"
  | "9:21";

const ASPECT_RATIO_VALUES: ReadonlySet<ImageAspectRatio> = new Set([
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "21:9",
  "9:21",
]);

const SYSTEM_PROMPT = `You compose prompts for an image-generation model.

The user has been chatting and now wants an image. Read their most recent request and the prior conversation, then write ONE detailed image-generation prompt describing what should be drawn, and pick the aspect ratio that best fits the intent.

Output strict JSON with exactly two fields:
- "prompt": string. The image-generation prompt. 40 to 160 words, single paragraph, no lists or headings. Focus on visual content: subject, style, composition, mood, palette, lighting, framing.
- "aspectRatio": one of "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "21:9" | "9:21". Pick based on explicit cues in the request:
  • Portrait / vertical / Instagram Story / Reel / TikTok / 9:16 / 1080×1920 / phone wallpaper → "9:16"
  • Landscape / horizontal / widescreen / desktop wallpaper / YouTube thumbnail / 16:9 / 1920×1080 → "16:9"
  • Cinematic / ultrawide / banner → "21:9"
  • Square / Instagram post / profile picture / 1:1 / 1024×1024 → "1:1"
  • Standard photo landscape / 4:3 → "4:3"
  • Standard photo portrait / 3:4 → "3:4"
  • Very tall poster / vertical banner → "9:21"
  • If the user didn't specify, default to "1:1".

Do not include any text outside the JSON. If the user's request is already a complete standalone prompt, polish it without injecting unrelated context. If the request refers to prior context ("generate it", "the flyer"), pull the relevant visual details from the conversation.`;

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

export interface SynthesizedImagePrompt {
  prompt: string;
  aspectRatio?: ImageAspectRatio;
}

function parseSynthesisOutput(raw: string): SynthesizedImagePrompt | null {
  try {
    const obj = JSON.parse(raw) as { prompt?: unknown; aspectRatio?: unknown };
    if (typeof obj.prompt !== "string" || obj.prompt.trim().length === 0) {
      return null;
    }
    const aspectRatio =
      typeof obj.aspectRatio === "string" &&
      ASPECT_RATIO_VALUES.has(obj.aspectRatio as ImageAspectRatio)
        ? (obj.aspectRatio as ImageAspectRatio)
        : undefined;
    return { prompt: obj.prompt.trim(), aspectRatio };
  } catch {
    return null;
  }
}

export async function synthesizeImagePrompt({
  history,
  userMessage,
  client: clientOverride,
}: SynthesizeImagePromptParams): Promise<SynthesizedImagePrompt> {
  const fallback: SynthesizedImagePrompt = {
    prompt: userMessage.trim() || userMessage,
  };
  const client = clientOverride ?? getClient();
  if (!client) return fallback;

  const conversationText = formatHistoryForSynthesis(history);
  const userBlock = conversationText
    ? `Conversation so far:\n\n${conversationText}\n\nUser's new request: ${userMessage}\n\nWrite the image-generation prompt as JSON.`
    : `User's request: ${userMessage}\n\nWrite the image-generation prompt as JSON.`;

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
        response_format: { type: "json_object" },
      },
      { signal: controller.signal }
    );

    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) return fallback;
    return parseSynthesisOutput(raw) ?? fallback;
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
