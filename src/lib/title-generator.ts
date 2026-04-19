import Anthropic from "@anthropic-ai/sdk";
import { logger } from "@/lib/logger";

/**
 * Short, human-readable title generation for newly-created conversations.
 *
 * Mirrors the pattern used by Claude.ai and ChatGPT: after the first user
 * message, a small/fast model produces a descriptive 3–7 word title. Runs
 * in parallel with the assistant's streaming response so the user never
 * waits for it. Falls back silently (returns `null`) on any failure so the
 * caller can keep the placeholder title that was written at insert time.
 */

/** Hard upper bound on the stored title length. Matches the DB/UI budget. */
export const TITLE_MAX_CHARS = 60;

/**
 * Model used for title generation. Haiku 4.5 is the fastest and cheapest
 * Claude model, and title generation does not benefit from a larger model —
 * the task is pure summarisation of a single short message.
 */
export const TITLE_MODEL = "claude-haiku-4-5-20251001" as const;

/** Cap on the user message sent to the model, as a defence against pathological inputs. */
const USER_MESSAGE_MAX_CHARS = 2000;

/** Output token cap. 24 tokens comfortably fits a 3–7 word title. */
const MAX_OUTPUT_TOKENS = 24;

const SYSTEM_PROMPT = [
  "You generate short, descriptive titles for chat conversations.",
  "Given the user's first message, respond with a title of 3 to 7 words in sentence case.",
  "Be specific to the user's topic — not generic like 'Help with code' or 'General question'.",
  "Output ONLY the title — no quotes, no prefix like 'Title:', no trailing punctuation, no markdown.",
].join(" ");

export interface GenerateConversationTitleOptions {
  /** Cancels the Anthropic request when the originating chat request is aborted. */
  signal?: AbortSignal;
  /** Correlates title-generator logs with the originating chat request. */
  requestId?: string;
}

let sharedClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (sharedClient) return sharedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");
  sharedClient = new Anthropic({ apiKey });
  return sharedClient;
}

/**
 * Generate a concise, human-readable conversation title from the user's
 * first message. Returns `null` on any failure (network, API, empty output)
 * so the caller can fall back to the placeholder title — title generation
 * must never surface an error to the chat flow.
 *
 * @example
 *   const title = await generateConversationTitle(
 *     "ok so i keep OOMing when i run pytest in docker halp",
 *   );
 *   // → "Diagnosing pytest Docker OOM"
 */
export async function generateConversationTitle(
  userMessage: string,
  options: GenerateConversationTitleOptions = {},
): Promise<string | null> {
  const log = logger.child({
    route: "title-generator",
    requestId: options.requestId,
  });

  const trimmed = userMessage.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const boundedMessage =
    trimmed.length > USER_MESSAGE_MAX_CHARS
      ? trimmed.slice(0, USER_MESSAGE_MAX_CHARS)
      : trimmed;

  try {
    const client = getAnthropicClient();
    const response = await client.messages.create(
      {
        model: TITLE_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.3,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: boundedMessage }],
      },
      options.signal ? { signal: options.signal } : undefined,
    );

    const raw = extractFirstTextBlock(response.content);
    if (!raw) {
      log.debug("Title generator returned empty content");
      return null;
    }

    const clean = sanitizeTitle(raw);
    if (!clean) {
      log.debug("Title generator output did not survive sanitisation", {
        raw: raw.slice(0, 120),
      });
      return null;
    }

    return clean;
  } catch (err) {
    // Request aborted by the caller (e.g. client disconnected): quiet exit.
    if (isAbortError(err)) {
      log.debug("Title generation aborted");
      return null;
    }
    log.warn("Title generation failed", undefined, err);
    return null;
  }
}

function extractFirstTextBlock(
  content: Anthropic.Messages.ContentBlock[],
): string | null {
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return null;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    // The Anthropic SDK surfaces aborts as APIUserAbortError.
    if (err.name === "APIUserAbortError") return true;
  }
  return false;
}

/**
 * Pure function — exported for unit testing.
 *
 * Normalises the model's raw output into a safe, human-readable title.
 * Handles every common failure mode (quotes, markdown, "Title:" prefix,
 * trailing punctuation, excess whitespace, over-long output). Returns
 * `null` when no usable title remains.
 *
 * @example
 *   sanitizeTitle('**Title:** "Debouncing a React search input."');
 *   // → "Debouncing a React search input"
 */
export function sanitizeTitle(raw: string): string | null {
  if (typeof raw !== "string") return null;

  let result = raw.trim();
  if (result.length === 0) return null;

  // Drop leading "Title:" / "**Title:**" — model sometimes ignores instructions.
  result = result.replace(/^\s*\*{0,2}\s*title\s*:\s*\*{0,2}\s*/i, "");

  // Remove markdown emphasis anywhere in the string. Do this before the
  // surrounding-pair strip so patterns like `**"foo"**` collapse cleanly.
  result = stripMarkdownEmphasis(result);

  // Strip surrounding quotes/backticks/parens, then trailing sentence
  // punctuation, and repeat — removing a trailing dot can reveal an outer
  // quote that was not a match before.
  for (let i = 0; i < 4; i++) {
    const before = result;
    result = stripSurroundingPair(result);
    result = result.replace(/[.?!,;:]+\s*$/u, "");
    if (result === before) break;
  }

  // Collapse internal whitespace and re-trim.
  result = result.replace(/\s+/g, " ").trim();

  if (result.length < 2) return null;

  if (result.length > TITLE_MAX_CHARS) {
    result = truncateAtWordBoundary(result, TITLE_MAX_CHARS);
  }

  return result.length >= 2 ? result : null;
}

function stripMarkdownEmphasis(input: string): string {
  // Remove bold markers and single-char emphasis wrappers.
  return input
    .replace(/\*\*/g, "")
    .replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](\s|$)/g, "$1$2$3");
}

const QUOTE_PAIRS: Array<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["\u201C", "\u201D"], // “ ”
  ["\u2018", "\u2019"], // ‘ ’
  ["(", ")"],
  ["[", "]"],
];

function stripSurroundingPair(input: string): string {
  const s = input.trim();
  if (s.length < 2) return s;
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.startsWith(open) && s.endsWith(close)) {
      return s.slice(open.length, s.length - close.length).trim();
    }
  }
  return s;
}

function truncateAtWordBoundary(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const slice = input.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  // Avoid aggressive cuts that would lose most of the title.
  if (lastSpace >= Math.floor(maxChars * 0.5)) {
    return slice.slice(0, lastSpace).trim();
  }
  return slice.trim();
}
