/**
 * Streaming parser for the `<araviel_title>...</araviel_title>` block that the
 * model is instructed to emit as the very first thing in the response for a
 * new conversation. The block is parsed out of the streamed content, stripped
 * from the visible deltas, and exposed as a structured title so the API layer
 * can push a `title` SSE event and update the conversation row in place.
 *
 * Mirrors the pattern established by {@link ./meta-parser.ts}.
 */

const TITLE_OPEN = "<araviel_title>";
const TITLE_CLOSE = "</araviel_title>";
const TITLE_MAX_CHARS = 60;

export interface TitleParseState {
  /** Raw content that has arrived so far. */
  buffer: string;
  /** True once we've resolved whether a title tag exists (found or missed). */
  resolved: boolean;
  /** The sanitized title if one was successfully extracted. */
  title: string | null;
  /** How many leading characters of the raw buffer have been consumed so they
   *  must not be emitted again as a delta. */
  consumedBufferLength: number;
}

export function createTitleParseState(): TitleParseState {
  return {
    buffer: "",
    resolved: false,
    title: null,
    consumedBufferLength: 0,
  };
}

export interface TitleParseResult {
  /** The sanitized title, if this chunk completed the tag. */
  title: string | null;
  /** Content that is safe to forward to the client as a delta. Never contains
   *  any part of the title tag. */
  deltaToEmit: string;
}

/**
 * Feed the next streamed chunk into the parser. Returns the portion of content
 * that is safe to forward as a visible delta and (once) the extracted title.
 *
 * The parser only inspects leading content — any characters that arrive before
 * non-whitespace, non-tag content has been emitted are considered part of the
 * title zone. Once a non-title character is encountered, the parser stops
 * looking and forwards all subsequent content verbatim.
 *
 * @example
 * const state = createTitleParseState();
 * const { title, deltaToEmit } = feedTitleChunk(state, "<araviel_title>Fix Docker OOM</araviel_title>Hello");
 * // title === "Fix Docker OOM"
 * // deltaToEmit === "Hello"
 */
export function feedTitleChunk(state: TitleParseState, chunk: string): TitleParseResult {
  if (state.resolved) {
    // Already past the title zone — everything flows through.
    return { title: null, deltaToEmit: chunk };
  }

  state.buffer += chunk;

  const leading = state.buffer.slice(state.consumedBufferLength);
  const trimmed = leading.trimStart();
  const whitespacePrefix = leading.length - trimmed.length;

  // Case 1: the buffer (ignoring leading whitespace) starts with a complete
  // open tag — look for the close tag to extract the title.
  if (trimmed.startsWith(TITLE_OPEN)) {
    const closeIdx = trimmed.indexOf(TITLE_CLOSE, TITLE_OPEN.length);
    if (closeIdx === -1) {
      // Still waiting for </araviel_title> — hold everything.
      return { title: null, deltaToEmit: "" };
    }

    const rawTitle = trimmed.slice(TITLE_OPEN.length, closeIdx);
    const sanitized = sanitizeTitle(rawTitle);
    const totalConsumedFromLeading =
      whitespacePrefix + closeIdx + TITLE_CLOSE.length;
    const tailFromLeading = leading.slice(totalConsumedFromLeading);

    state.title = sanitized;
    state.resolved = true;
    state.consumedBufferLength += leading.length; // whole leading window consumed

    return { title: sanitized, deltaToEmit: tailFromLeading };
  }

  // Case 2: the buffer could still be a prefix of the open tag (including any
  // leading whitespace before it). Keep holding.
  if (couldBeTitlePrefix(trimmed)) {
    return { title: null, deltaToEmit: "" };
  }

  // Case 3: what arrived isn't a title tag at all — mark resolved and forward
  // the whole leading window as a delta.
  state.resolved = true;
  state.consumedBufferLength += leading.length;
  return { title: null, deltaToEmit: leading };
}

/** Flush any buffered content once the stream has ended. */
export function flushTitleParser(state: TitleParseState): string {
  if (state.resolved) return "";
  const leading = state.buffer.slice(state.consumedBufferLength);
  state.resolved = true;
  state.consumedBufferLength += leading.length;
  return leading;
}

function couldBeTitlePrefix(text: string): boolean {
  if (text.length === 0) return true;
  if (text.length >= TITLE_OPEN.length) return false;
  return TITLE_OPEN.startsWith(text);
}

/**
 * Fallback extractor for `<araviel_title>…</araviel_title>` blocks that arrive
 * anywhere in the accumulated response — not just at the leading edge. Models
 * occasionally forget the "output the title first" instruction and emit the
 * block at the end of the response; this function strips every occurrence and
 * returns the first successfully sanitized title.
 *
 * Mirrors {@link extractAravielMeta} from `meta-parser.ts`.
 */
export function extractAravielTitle(content: string): {
  cleanContent: string;
  title: string | null;
} {
  if (!content || !content.includes(TITLE_OPEN)) {
    return { cleanContent: content, title: null };
  }

  let cleaned = "";
  let cursor = 0;
  let title: string | null = null;
  let strippedAtStart = false;

  while (cursor < content.length) {
    const openIdx = content.indexOf(TITLE_OPEN, cursor);
    if (openIdx === -1) {
      cleaned += content.slice(cursor);
      break;
    }
    const closeIdx = content.indexOf(TITLE_CLOSE, openIdx + TITLE_OPEN.length);
    if (closeIdx === -1) {
      // Unterminated tag — leave the remainder untouched so the original flush
      // path can surface it verbatim rather than silently eating content.
      cleaned += content.slice(cursor);
      break;
    }

    // Preserve text before the tag, trimming a single surrounding blank line
    // so stripped blocks don't leave odd gaps.
    let prefix = content.slice(cursor, openIdx);
    let suffixStart = closeIdx + TITLE_CLOSE.length;

    // If the block sits on its own line, absorb one trailing newline to avoid
    // leaving a dangling blank line in the visible content.
    if (/\n\s*$/.test(prefix) && content[suffixStart] === "\n") {
      suffixStart += 1;
    } else if (prefix.endsWith("\n\n")) {
      prefix = prefix.slice(0, -1);
    }

    if (cursor === 0 && prefix.trim().length === 0) {
      // Block sits at the very beginning — drop any leading whitespace so the
      // cleaned output doesn't start with a phantom blank line.
      strippedAtStart = true;
      prefix = "";
    }

    cleaned += prefix;
    if (title === null) {
      const raw = content.slice(openIdx + TITLE_OPEN.length, closeIdx);
      title = sanitizeTitle(raw);
    }
    cursor = suffixStart;
  }

  let result = cleaned.trimEnd();
  if (strippedAtStart) {
    result = result.replace(/^\s+/, "");
  }
  return { cleanContent: result, title };
}

/**
 * Does `text` contain a partial `<araviel_title>` tag that could still complete
 * as more content streams in? Used by the delta flusher to hold back in-flight
 * tag characters so they never flash visibly.
 */
export function containsPartialTitle(text: string): boolean {
  if (text.includes(TITLE_OPEN) && !text.includes(TITLE_CLOSE)) return true;
  for (let i = 1; i <= TITLE_OPEN.length && i <= text.length; i++) {
    if (TITLE_OPEN.startsWith(text.slice(-i))) return true;
  }
  return false;
}

/**
 * Clean a raw model-produced title: strip wrapping punctuation, collapse
 * whitespace, drop markdown emphasis, cap at {@link TITLE_MAX_CHARS} at a word
 * boundary. Returns `null` for anything too short or unusable.
 *
 * Pure function — exported for unit testing.
 *
 * @example
 * sanitizeTitle('**"Diagnosing pytest Docker OOM."**') // "Diagnosing pytest Docker OOM"
 * sanitizeTitle("   ")                                  // null
 */
export function sanitizeTitle(raw: string): string | null {
  if (typeof raw !== "string") return null;

  let value = raw.replace(/\s+/g, " ").trim();
  if (value.length === 0) return null;

  value = stripMarkdownEmphasis(value);

  // Alternate stripping surrounding wrappers and trailing punctuation so
  // `**"Title."**` → `"Title."` → `"Title"` → `Title`.
  let changed = true;
  while (changed) {
    changed = false;
    const afterPair = stripSurroundingPair(value);
    if (afterPair !== value) {
      value = afterPair;
      changed = true;
    }
    const afterPunct = value.replace(/[.?!,;:]+$/u, "").trim();
    if (afterPunct !== value) {
      value = afterPunct;
      changed = true;
    }
  }

  value = value.replace(/^title\s*[:\-—]\s*/i, "").trim();

  if (value.length < 2) return null;

  if (value.length > TITLE_MAX_CHARS) {
    const sliced = value.slice(0, TITLE_MAX_CHARS);
    const lastSpace = sliced.lastIndexOf(" ");
    value = (lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced).trim();
  }

  return value.length >= 2 ? value : null;
}

function stripMarkdownEmphasis(value: string): string {
  return value.replace(/(\*\*|__|\*|_)(.+?)\1/gu, "$2").trim();
}

const WRAPPER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["\u201C", "\u201D"], // left/right double smart quote
  ["\u2018", "\u2019"], // left/right single smart quote
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
];

function stripSurroundingPair(value: string): string {
  if (value.length < 2) return value;
  for (const [open, close] of WRAPPER_PAIRS) {
    if (value.startsWith(open) && value.endsWith(close)) {
      return value.slice(open.length, value.length - close.length).trim();
    }
  }
  return value;
}

export { TITLE_MAX_CHARS, TITLE_OPEN, TITLE_CLOSE };
