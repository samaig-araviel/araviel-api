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

// Tolerant close-tag matcher. Models occasionally corrupt the closing tag with
// letter repetition (observed in production: "</araraviel_title>"), which
// silently breaks a strict-string search and causes the entire title block to
// leak verbatim into the response. The pattern allows extra word characters
// around "araviel" and "title" so common single-token glitches still match.
const TITLE_CLOSE_RE = /<\/\s*[A-Za-z_]*araviel[A-Za-z_]*title[A-Za-z_]*\s*>/i;
const TITLE_MARKER_RE_GLOBAL = /<\/?\s*[A-Za-z_]*araviel[A-Za-z_]*title[A-Za-z_]*\s*>/gi;

/**
 * Locate the first close-tag match at or after `fromIdx`. Returns the absolute
 * index and matched length, or null if no tolerant match is found.
 */
export function findTitleClose(
  text: string,
  fromIdx = 0,
): { index: number; length: number } | null {
  if (fromIdx < 0) fromIdx = 0;
  if (fromIdx >= text.length) return null;
  const m = text.slice(fromIdx).match(TITLE_CLOSE_RE);
  if (!m || m.index === undefined) return null;
  return { index: fromIdx + m.index, length: m[0].length };
}

/**
 * Remove any stray title open/close markers from the given text. Used as a
 * last-line safety net so that orphan tags (without a matching counterpart)
 * never reach the client even when the model produces malformed markup.
 */
export function stripStrayTitleMarkers(text: string): string {
  return text.replace(TITLE_MARKER_RE_GLOBAL, "");
}

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
    const close = findTitleClose(trimmed, TITLE_OPEN.length);
    if (!close) {
      // Still waiting for the close tag — hold everything.
      return { title: null, deltaToEmit: "" };
    }

    const rawTitle = trimmed.slice(TITLE_OPEN.length, close.index);
    const sanitized = sanitizeTitle(rawTitle);
    const totalConsumedFromLeading =
      whitespacePrefix + close.index + close.length;
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
    const close = findTitleClose(content, openIdx + TITLE_OPEN.length);
    if (!close) {
      // Unterminated tag — leave the remainder untouched so the original flush
      // path can surface it verbatim rather than silently eating content.
      cleaned += content.slice(cursor);
      break;
    }

    // Preserve text before the tag, trimming a single surrounding blank line
    // so stripped blocks don't leave odd gaps.
    let prefix = content.slice(cursor, openIdx);
    let suffixStart = close.index + close.length;

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
      const raw = content.slice(openIdx + TITLE_OPEN.length, close.index);
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
  const openIdx = text.indexOf(TITLE_OPEN);
  if (openIdx !== -1 && !findTitleClose(text, openIdx + TITLE_OPEN.length)) {
    return true;
  }
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
  ["“", "”"], // left/right double smart quote
  ["‘", "’"], // left/right single smart quote
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
