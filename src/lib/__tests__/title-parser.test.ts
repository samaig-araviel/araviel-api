import { describe, it, expect } from "vitest";
import {
  sanitizeTitle,
  createTitleParseState,
  feedTitleChunk,
  flushTitleParser,
  extractAravielTitle,
  containsPartialTitle,
  findTitleClose,
  stripStrayTitleMarkers,
  TITLE_MAX_CHARS,
} from "@/lib/stream/title-parser";

describe("sanitizeTitle", () => {
  it("returns null for empty input", () => {
    expect(sanitizeTitle("")).toBeNull();
    expect(sanitizeTitle("   ")).toBeNull();
    expect(sanitizeTitle("\n\t ")).toBeNull();
  });

  it("returns null when the sanitized result is too short", () => {
    expect(sanitizeTitle("A")).toBeNull();
    expect(sanitizeTitle("...")).toBeNull();
    expect(sanitizeTitle('""')).toBeNull();
  });

  it("trims and collapses whitespace", () => {
    expect(sanitizeTitle("  Hello   world  ")).toBe("Hello world");
    expect(sanitizeTitle("Line\nbreak")).toBe("Line break");
  });

  it("strips surrounding straight quotes", () => {
    expect(sanitizeTitle('"Fix Docker OOM"')).toBe("Fix Docker OOM");
    expect(sanitizeTitle("'Fix Docker OOM'")).toBe("Fix Docker OOM");
  });

  it("strips surrounding smart quotes", () => {
    expect(sanitizeTitle("“Fix Docker OOM”")).toBe("Fix Docker OOM");
    expect(sanitizeTitle("‘Fix Docker OOM’")).toBe("Fix Docker OOM");
  });

  it("strips surrounding backticks, parens, and brackets", () => {
    expect(sanitizeTitle("`Fix Docker OOM`")).toBe("Fix Docker OOM");
    expect(sanitizeTitle("(Fix Docker OOM)")).toBe("Fix Docker OOM");
    expect(sanitizeTitle("[Fix Docker OOM]")).toBe("Fix Docker OOM");
    expect(sanitizeTitle("{Fix Docker OOM}")).toBe("Fix Docker OOM");
  });

  it("strips trailing punctuation", () => {
    expect(sanitizeTitle("Fix Docker OOM.")).toBe("Fix Docker OOM");
    expect(sanitizeTitle("Fix Docker OOM?")).toBe("Fix Docker OOM");
    expect(sanitizeTitle("Fix Docker OOM!")).toBe("Fix Docker OOM");
    expect(sanitizeTitle("Fix Docker OOM;")).toBe("Fix Docker OOM");
    expect(sanitizeTitle("Fix Docker OOM:")).toBe("Fix Docker OOM");
  });

  it("drops a leading Title: prefix", () => {
    expect(sanitizeTitle("Title: Fix Docker OOM")).toBe("Fix Docker OOM");
    expect(sanitizeTitle("title - Fix Docker OOM")).toBe("Fix Docker OOM");
  });

  it("removes markdown emphasis wrappers", () => {
    expect(sanitizeTitle("**Fix Docker OOM**")).toBe("Fix Docker OOM");
    expect(sanitizeTitle("*Fix Docker OOM*")).toBe("Fix Docker OOM");
    expect(sanitizeTitle("__Fix Docker OOM__")).toBe("Fix Docker OOM");
  });

  it("handles combined wrappers and trailing punctuation", () => {
    expect(sanitizeTitle('**"Diagnosing pytest Docker OOM."**')).toBe(
      "Diagnosing pytest Docker OOM",
    );
    expect(sanitizeTitle('"Title: Fix OOM."')).toBe("Fix OOM");
  });

  it("truncates to TITLE_MAX_CHARS at the last word boundary", () => {
    const longTitle =
      "This is an extremely long conversation title that goes on forever past sixty chars";
    const out = sanitizeTitle(longTitle);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(out!.endsWith(" ")).toBe(false);
    // Must not chop mid-word — every word in the result is a full word of the input
    const inputWords = longTitle.split(" ");
    const outWords = out!.split(" ");
    for (const w of outWords) {
      expect(inputWords).toContain(w);
    }
  });
});

describe("title stream parser", () => {
  it("extracts a title delivered in a single chunk", async () => {
    const state = createTitleParseState();
    const { title, deltaToEmit } = feedTitleChunk(
      state,
      "<araviel_title>Diagnosing pytest OOM</araviel_title>Here is the answer.",
    );
    expect(title).toBe("Diagnosing pytest OOM");
    expect(deltaToEmit).toBe("Here is the answer.");
    expect(state.resolved).toBe(true);
  });

  it("holds back output until the closing tag arrives across chunks", async () => {
    const state = createTitleParseState();
    const first = feedTitleChunk(state, "<araviel_title>Diagnosing");
    expect(first.title).toBeNull();
    expect(first.deltaToEmit).toBe("");
    expect(state.resolved).toBe(false);

    const second = feedTitleChunk(state, " pytest OOM</araviel_title>And ");
    expect(second.title).toBe("Diagnosing pytest OOM");
    expect(second.deltaToEmit).toBe("And ");
    expect(state.resolved).toBe(true);

    const third = feedTitleChunk(state, "here is more.");
    expect(third.title).toBeNull();
    expect(third.deltaToEmit).toBe("here is more.");
  });

  it("passes through content verbatim when the model ignores the instruction", () => {
    const state = createTitleParseState();
    const { title, deltaToEmit } = feedTitleChunk(state, "Hello there!");
    expect(title).toBeNull();
    expect(deltaToEmit).toBe("Hello there!");
    expect(state.resolved).toBe(true);
  });

  it("tolerates leading whitespace before the tag", () => {
    const state = createTitleParseState();
    const { title, deltaToEmit } = feedTitleChunk(
      state,
      "\n  <araviel_title>Quick title</araviel_title>rest",
    );
    expect(title).toBe("Quick title");
    expect(deltaToEmit).toBe("rest");
  });

  it("holds through a partial open tag split across chunks", () => {
    const state = createTitleParseState();

    const a = feedTitleChunk(state, "<ara");
    expect(a.deltaToEmit).toBe("");
    expect(state.resolved).toBe(false);

    const b = feedTitleChunk(state, "viel_title>Short");
    expect(b.deltaToEmit).toBe("");
    expect(b.title).toBeNull();

    const c = feedTitleChunk(state, "</araviel_title>body");
    expect(c.title).toBe("Short");
    expect(c.deltaToEmit).toBe("body");
  });

  it("flushes leftover content when the stream ends without closing the tag", () => {
    const state = createTitleParseState();
    feedTitleChunk(state, "<araviel_title>Unclosed");
    const leftover = flushTitleParser(state);
    expect(leftover).toBe("<araviel_title>Unclosed");
    expect(state.resolved).toBe(true);
  });

  it("returns null title when the block is empty", () => {
    const state = createTitleParseState();
    const { title, deltaToEmit } = feedTitleChunk(
      state,
      "<araviel_title></araviel_title>body",
    );
    expect(title).toBeNull();
    expect(deltaToEmit).toBe("body");
  });

  it("does not re-parse once resolved", () => {
    const state = createTitleParseState();
    feedTitleChunk(state, "Plain content.");
    const { title, deltaToEmit } = feedTitleChunk(
      state,
      "<araviel_title>Late</araviel_title>tail",
    );
    expect(title).toBeNull();
    expect(deltaToEmit).toBe("<araviel_title>Late</araviel_title>tail");
  });
});

describe("extractAravielTitle", () => {
  it("returns the content unchanged when no title tag is present", () => {
    const { cleanContent, title } = extractAravielTitle("Just a plain answer.");
    expect(cleanContent).toBe("Just a plain answer.");
    expect(title).toBeNull();
  });

  it("strips a trailing title block and returns the sanitized title", () => {
    const content =
      "Here's your detailed answer.\n\n<araviel_title>Isle of Wight trip budget review</araviel_title>";
    const { cleanContent, title } = extractAravielTitle(content);
    expect(title).toBe("Isle of Wight trip budget review");
    expect(cleanContent).toBe("Here's your detailed answer.");
    expect(cleanContent).not.toContain("<araviel_title>");
    expect(cleanContent).not.toContain("</araviel_title>");
  });

  it("strips a leading title block", () => {
    const { cleanContent, title } = extractAravielTitle(
      "<araviel_title>Quick hello</araviel_title>\nHello there!",
    );
    expect(title).toBe("Quick hello");
    expect(cleanContent).toBe("Hello there!");
  });

  it("strips a mid-content title block and preserves surrounding text", () => {
    const { cleanContent, title } = extractAravielTitle(
      "Before.\n<araviel_title>Middle</araviel_title>\nAfter.",
    );
    expect(title).toBe("Middle");
    expect(cleanContent).toBe("Before.\nAfter.");
  });

  it("strips multiple title blocks and returns the first sanitized one", () => {
    const { cleanContent, title } = extractAravielTitle(
      "A <araviel_title>First title</araviel_title> B <araviel_title>Second title</araviel_title> C",
    );
    expect(title).toBe("First title");
    expect(cleanContent).toBe("A  B  C");
  });

  it("leaves unterminated tags alone (caller will flush them verbatim)", () => {
    const content = "Answer.\n<araviel_title>Never closed";
    const { cleanContent, title } = extractAravielTitle(content);
    expect(title).toBeNull();
    expect(cleanContent).toBe(content.trimEnd());
  });

  it("returns null title when the block body is empty", () => {
    const { cleanContent, title } = extractAravielTitle(
      "Hi<araviel_title></araviel_title> there",
    );
    expect(title).toBeNull();
    expect(cleanContent).toBe("Hi there");
  });
});

describe("containsPartialTitle", () => {
  it("flags an open tag without a close", () => {
    expect(containsPartialTitle("prefix <araviel_title>Incomp")).toBe(true);
  });

  it("flags a tail that could still grow into the open tag", () => {
    expect(containsPartialTitle("text <arav")).toBe(true);
    expect(containsPartialTitle("text <a")).toBe(true);
  });

  it("does not flag content with a complete title block", () => {
    expect(
      containsPartialTitle("pre <araviel_title>Done</araviel_title> post"),
    ).toBe(false);
  });

  it("does not flag unrelated content", () => {
    expect(containsPartialTitle("Just a sentence.")).toBe(false);
    expect(containsPartialTitle("Some <other> tag")).toBe(false);
  });

  it("treats a corrupted close tag as a complete block (no longer partial)", () => {
    expect(
      containsPartialTitle(
        "<araviel_title>Drafting an email</araraviel_title> body",
      ),
    ).toBe(false);
  });
});

describe("corrupted close tag tolerance", () => {
  // Models occasionally emit "</araraviel_title>" — a single-token repetition
  // glitch where the closing tag name picks up an extra "ar". Without tolerant
  // matching, this leaks the entire block verbatim into the user-visible
  // response (production bug observed 2026-05-03).
  it("feedTitleChunk extracts the title even when the close tag is corrupted", () => {
    const state = createTitleParseState();
    const { title, deltaToEmit } = feedTitleChunk(
      state,
      "<araviel_title>Drafting an email</araraviel_title>Body here",
    );
    expect(title).toBe("Drafting an email");
    expect(deltaToEmit).toBe("Body here");
    expect(state.resolved).toBe(true);
  });

  it("extractAravielTitle strips a block with a corrupted close tag", () => {
    const { cleanContent, title } = extractAravielTitle(
      "<araviel_title>Drafting an email</araraviel_title>\n\nBody",
    );
    expect(title).toBe("Drafting an email");
    expect(cleanContent).toBe("Body");
    expect(cleanContent).not.toContain("araviel_title");
  });

  it("extractAravielTitle handles whitespace and casing in a corrupted close tag", () => {
    const { cleanContent, title } = extractAravielTitle(
      "<araviel_title>Hi</ Araraviel_Title >tail",
    );
    expect(title).toBe("Hi");
    expect(cleanContent).toBe("tail");
  });

  it("findTitleClose locates the canonical close tag", () => {
    const text = "abc</araviel_title>def";
    expect(findTitleClose(text)).toEqual({ index: 3, length: 16 });
  });

  it("findTitleClose locates a corrupted close tag", () => {
    const text = "abc</araraviel_title>def";
    expect(findTitleClose(text)).toEqual({ index: 3, length: 18 });
  });

  it("findTitleClose returns null when no close tag is present", () => {
    expect(findTitleClose("plain text")).toBeNull();
  });

  it("stripStrayTitleMarkers removes orphan opens and closes (canonical and corrupted)", () => {
    expect(stripStrayTitleMarkers("hello <araviel_title> world")).toBe(
      "hello  world",
    );
    expect(stripStrayTitleMarkers("hello </araraviel_title> world")).toBe(
      "hello  world",
    );
    expect(stripStrayTitleMarkers("plain text")).toBe("plain text");
  });
});
