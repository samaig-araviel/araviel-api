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
  const cleanContent = content.slice(0, openIdx).trimEnd();

  try {
    const parsed = JSON.parse(jsonStr);
    const meta = validateMeta(parsed);
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
    .slice(0, 3)
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
        .slice(0, 3)
        .map((s) => s.trim()),
    }))
    .filter((q) => q.options.length > 0);
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
