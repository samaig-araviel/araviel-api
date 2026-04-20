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
