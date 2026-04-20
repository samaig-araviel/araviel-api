import { describe, it, expect } from "vitest";
import {
  sanitizeTitle,
  createTitleParseState,
  feedTitleChunk,
  flushTitleParser,
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
    expect(sanitizeTitle("\u201CFix Docker OOM\u201D")).toBe("Fix Docker OOM");
    expect(sanitizeTitle("\u2018Fix Docker OOM\u2019")).toBe("Fix Docker OOM");
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
