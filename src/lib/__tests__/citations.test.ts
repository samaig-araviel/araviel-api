import { describe, it, expect } from "vitest";
import { dedupeCitations, normalizeCitationUrl } from "@/lib/citations";

describe("normalizeCitationUrl", () => {
  it("returns empty string for empty input", () => {
    expect(normalizeCitationUrl("")).toBe("");
  });

  it("strips protocol and leading www.", () => {
    expect(normalizeCitationUrl("https://www.example.com/page")).toBe(
      "example.com/page",
    );
    expect(normalizeCitationUrl("http://example.com/page")).toBe(
      "example.com/page",
    );
  });

  it("strips trailing slashes on the path", () => {
    expect(normalizeCitationUrl("https://example.com/page/")).toBe(
      "example.com/page",
    );
    expect(normalizeCitationUrl("https://example.com/")).toBe("example.com");
  });

  it("lowercases the host but preserves path casing", () => {
    expect(normalizeCitationUrl("https://Example.COM/MyPage")).toBe(
      "example.com/MyPage",
    );
  });

  it("drops the fragment but keeps the query", () => {
    expect(normalizeCitationUrl("https://example.com/a?x=1#section")).toBe(
      "example.com/a?x=1",
    );
  });

  it("returns the trimmed input unchanged when parsing fails", () => {
    expect(normalizeCitationUrl("  not a url  ")).toBe("not a url");
  });
});

describe("dedupeCitations", () => {
  it("returns an empty array for empty input", () => {
    expect(dedupeCitations([])).toEqual([]);
  });

  it("preserves a single-source list unchanged", () => {
    const input = [{ url: "https://example.com/a", title: "A" }];
    expect(dedupeCitations(input)).toEqual(input);
  });

  it("collapses exact-duplicate URLs to one entry", () => {
    const out = dedupeCitations([
      { url: "https://example.com/a", title: "A" },
      { url: "https://example.com/a", title: "A" },
      { url: "https://example.com/a", title: "A" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://example.com/a");
  });

  it("treats protocol, www, and trailing-slash variants as duplicates", () => {
    const out = dedupeCitations([
      { url: "https://example.com/page", title: "Example" },
      { url: "http://www.example.com/page/", title: "Example" },
      { url: "https://EXAMPLE.com/page", title: "Example" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://example.com/page");
  });

  it("keeps entries whose paths differ", () => {
    const out = dedupeCitations([
      { url: "https://example.com/a", title: "A" },
      { url: "https://example.com/b", title: "B" },
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps entries whose query strings differ", () => {
    const out = dedupeCitations([
      { url: "https://youtube.com/watch?v=abc", title: "A" },
      { url: "https://youtube.com/watch?v=def", title: "B" },
    ]);
    expect(out).toHaveLength(2);
  });

  it("preserves insertion order of first occurrence", () => {
    const out = dedupeCitations([
      { url: "https://a.com", title: "A" },
      { url: "https://b.com", title: "B" },
      { url: "https://a.com", title: "A" },
      { url: "https://c.com", title: "C" },
    ]);
    expect(out.map((c) => c.url)).toEqual([
      "https://a.com",
      "https://b.com",
      "https://c.com",
    ]);
  });

  it("upgrades the kept record with a snippet from a later duplicate", () => {
    const out = dedupeCitations([
      { url: "https://example.com/a", title: "A" },
      { url: "https://example.com/a", title: "A", snippet: "extra detail" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].snippet).toBe("extra detail");
  });

  it("upgrades a URL-fallback title when a descriptive one arrives later", () => {
    const out = dedupeCitations([
      { url: "https://example.com/a", title: "https://example.com/a" },
      { url: "https://example.com/a", title: "A descriptive title" },
    ]);
    expect(out[0].title).toBe("A descriptive title");
  });

  it("skips records with missing or empty URLs", () => {
    const out = dedupeCitations([
      { url: "", title: "empty" },
      { url: "https://example.com/a", title: "A" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://example.com/a");
  });

  it("handles the pathological Perplexity case — 2950 duplicates collapse to 10", () => {
    const base = Array.from({ length: 10 }, (_, i) => ({
      url: `https://site.com/page/${i}`,
      title: `Page ${i}`,
    }));
    const inflated = [...Array(295)].flatMap(() => base);
    expect(inflated).toHaveLength(2950);
    const out = dedupeCitations(inflated);
    expect(out).toHaveLength(10);
    expect(out.map((c) => c.url)).toEqual(base.map((c) => c.url));
  });

  it("does not mutate the input array", () => {
    const input = [
      { url: "https://example.com/a", title: "A" },
      { url: "https://example.com/a", title: "A" },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    dedupeCitations(input);
    expect(input).toEqual(snapshot);
  });
});
