import type { FollowUpQuestion } from "@/lib/types";

export interface AravielMeta {
  followUps: string[];
  questions: FollowUpQuestion[];
}

const META_OPEN = "<araviel_meta>";
const META_CLOSE = "</araviel_meta>";

/**
 * Extract and strip the <araviel_meta> block from accumulated response content.
 * Returns the cleaned content and parsed metadata (if valid).
 */
export function extractAravielMeta(content: string): {
  cleanContent: string;
  meta: AravielMeta | null;
} {
  const openIdx = content.lastIndexOf(META_OPEN);
  if (openIdx === -1) {
    return { cleanContent: content, meta: null };
  }

  const closeIdx = content.indexOf(META_CLOSE, openIdx);
  if (closeIdx === -1) {
    return { cleanContent: content, meta: null };
  }

  const jsonStr = content.slice(openIdx + META_OPEN.length, closeIdx).trim();
  let cleanContent = content.slice(0, openIdx).trimEnd();

  try {
    const parsed = JSON.parse(jsonStr);
    const meta = validateMeta(parsed);

    // Safety net: if the AI included questions in the metadata, strip any trailing
    // question block from the visible response (e.g. "Would you like me to:\n- option A\n- option B")
    if (meta && meta.questions.length > 0) {
      cleanContent = stripTrailingQuestions(cleanContent);
    }

    return { cleanContent, meta };
  } catch {
    return { cleanContent, meta: null };
  }
}

function validateMeta(raw: unknown): AravielMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const followUps = validateFollowUps(obj.followUps);
  const questions = validateQuestions(obj.questions);

  if (followUps.length === 0 && questions.length === 0) return null;

  return { followUps, questions };
}

function validateFollowUps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, 5)
    .map((s) => s.trim());
}

function validateQuestions(raw: unknown): FollowUpQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => {
      if (!item || typeof item !== "object") return false;
      const q = item as Record<string, unknown>;
      return (
        typeof q.question === "string" &&
        q.question.trim().length > 0 &&
        Array.isArray(q.options) &&
        q.options.length > 0
      );
    })
    .map((item) => ({
      question: (item.question as string).trim(),
      options: (item.options as unknown[])
        .filter((o): o is string => typeof o === "string" && o.trim().length > 0)
        .slice(0, 5)
        .map((s) => s.trim()),
    }))
    .filter((q) => q.options.length > 0);
}

/**
 * Strip trailing question/choice blocks that the AI may have included in the visible
 * response despite instructions not to. Handles patterns like:
 * - "Would you like me to:\n- option A\n- option B\n- option C"
 * - "Do you prefer:\n1. X\n2. Y\n3. Z"
 * - "Which would you like?\n* A\n* B"
 * - "Let me know if you'd like to:\n- ..."
 *
 * Only strips from the END of the content to avoid removing legitimate inline lists.
 */
function stripTrailingQuestions(content: string): string {
  // Pattern: a question lead-in line followed by a bullet/numbered list at the very end.
  // The lead-in contains phrases like "would you like", "do you want", "do you prefer",
  // "which would you", "let me know", "shall I", "should I", etc.
  const trailingQuestionPattern =
    /\n{0,3}(?:would you like(?: me to| to)?|do you (?:want|prefer)|which (?:would you|do you|one)|let me know (?:if|which|what|whether)|shall I|should I|here are (?:some|a few|your) (?:options|choices)|I can (?:also|either))[^\n]*:\s*\n(?:\s*[-*•]\s+.+\n?){1,5}\s*$/i;

  const stripped = content.replace(trailingQuestionPattern, "").trimEnd();

  // Also handle numbered list variants (1. / 2. / 3.)
  const numberedVariant =
    /\n{0,3}(?:would you like(?: me to| to)?|do you (?:want|prefer)|which (?:would you|do you|one)|let me know (?:if|which|what|whether)|shall I|should I|here are (?:some|a few|your) (?:options|choices)|I can (?:also|either))[^\n]*:\s*\n(?:\s*\d+[.)]\s+.+\n?){1,5}\s*$/i;

  const result = stripped.replace(numberedVariant, "").trimEnd();

  // Also strip a trailing standalone question line that just asks "Would you like me to..." with options
  // but formatted as "(a) X, (b) Y, (c) Z" inline
  const inlineOptions =
    /\n{0,3}(?:would you like(?: me to| to)?|do you (?:want|prefer)|which (?:would you|do you|one)|shall I|should I)[^\n]*\?\s*$/i;

  return result.replace(inlineOptions, "").trimEnd();
}

/**
 * Check if the tail of streamed content might contain a partial <araviel_meta> block.
 * Used for tail buffering to prevent the metadata from flashing in the UI.
 */
export function containsPartialMeta(text: string): boolean {
  // Check if the text contains the start of a meta block without a closing tag
  if (text.includes(META_OPEN) && !text.includes(META_CLOSE)) return true;

  // Check if we're seeing partial opening tag characters at the end
  const tail = text.slice(-META_OPEN.length);
  for (let i = 1; i <= META_OPEN.length; i++) {
    if (META_OPEN.startsWith(tail.slice(-i))) return true;
  }

  return false;
}
