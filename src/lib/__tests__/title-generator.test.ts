import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { sanitizeTitle, TITLE_MAX_CHARS } from "@/lib/title-generator";

// ─── sanitizeTitle ────────────────────────────────────────────────────────────

describe("sanitizeTitle", () => {
  it("returns a clean title unchanged", () => {
    expect(sanitizeTitle("Debouncing a React search input")).toBe(
      "Debouncing a React search input"
    );
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeTitle("  Picking a database  ")).toBe("Picking a database");
  });

  it("collapses internal whitespace", () => {
    expect(sanitizeTitle("Picking   a\tdatabase")).toBe("Picking a database");
  });

  it("strips straight double quotes", () => {
    expect(sanitizeTitle('"Picking a database"')).toBe("Picking a database");
  });

  it("strips single quotes and backticks", () => {
    expect(sanitizeTitle("'Picking a database'")).toBe("Picking a database");
    expect(sanitizeTitle("`Picking a database`")).toBe("Picking a database");
  });

  it("strips smart (curly) quotes", () => {
    expect(sanitizeTitle("\u201CPicking a database\u201D")).toBe(
      "Picking a database"
    );
    expect(sanitizeTitle("\u2018Picking a database\u2019")).toBe(
      "Picking a database"
    );
  });

  it("strips surrounding parens and brackets", () => {
    expect(sanitizeTitle("(Picking a database)")).toBe("Picking a database");
    expect(sanitizeTitle("[Picking a database]")).toBe("Picking a database");
  });

  it("drops a leading 'Title:' prefix (any casing)", () => {
    expect(sanitizeTitle("Title: Picking a database")).toBe(
      "Picking a database"
    );
    expect(sanitizeTitle("title: picking a database")).toBe(
      "picking a database"
    );
  });

  it("drops a markdown-wrapped 'Title:' prefix", () => {
    expect(sanitizeTitle("**Title:** Picking a database")).toBe(
      "Picking a database"
    );
  });

  it("drops trailing sentence punctuation", () => {
    expect(sanitizeTitle("Picking a database.")).toBe("Picking a database");
    expect(sanitizeTitle("Picking a database?")).toBe("Picking a database");
    expect(sanitizeTitle("Picking a database!")).toBe("Picking a database");
    expect(sanitizeTitle("Picking a database;")).toBe("Picking a database");
  });

  it("strips markdown bold wrappers", () => {
    expect(sanitizeTitle("**Picking a database**")).toBe("Picking a database");
  });

  it("handles combined wrappers (bold + quotes + trailing dot)", () => {
    expect(sanitizeTitle('**"Picking a database."**')).toBe(
      "Picking a database"
    );
  });

  it("returns null for empty input", () => {
    expect(sanitizeTitle("")).toBeNull();
    expect(sanitizeTitle("   ")).toBeNull();
  });

  it("returns null for single-character output", () => {
    expect(sanitizeTitle("a")).toBeNull();
    expect(sanitizeTitle("!")).toBeNull();
  });

  it("truncates at a word boundary when over the length cap", () => {
    const longTitle =
      "Debugging a really tricky memory leak in our production web worker pipeline";
    const result = sanitizeTitle(longTitle);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    // Must not end mid-word: the last character should be alphanumeric.
    expect(result![result!.length - 1]).toMatch(/[a-zA-Z0-9]/);
    // Must not include a trailing space.
    expect(result!).toBe(result!.trim());
  });

  it("does not collapse shorter titles", () => {
    const title = "Short crisp title";
    expect(sanitizeTitle(title)).toBe(title);
  });

  it("handles non-string input defensively", () => {
    // Intentional: guard behaviour under a weak type at the boundary.
    expect(sanitizeTitle(undefined as unknown as string)).toBeNull();
    expect(sanitizeTitle(null as unknown as string)).toBeNull();
  });
});

// ─── generateConversationTitle (failure-mode contract) ────────────────────────

describe("generateConversationTitle", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null instead of throwing when the Anthropic SDK rejects", async () => {
    vi.doMock("@anthropic-ai/sdk", () => {
      class MockAnthropic {
        messages = {
          create: vi.fn().mockRejectedValue(new Error("network down")),
        };
      }
      return { default: MockAnthropic };
    });
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-key";

    try {
      const { generateConversationTitle } = await import(
        "@/lib/title-generator"
      );
      const result = await generateConversationTitle("How do I sort a list?");
      expect(result).toBeNull();
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it("returns null for an empty user message without calling the SDK", async () => {
    const create = vi.fn();
    vi.doMock("@anthropic-ai/sdk", () => {
      class MockAnthropic {
        messages = { create };
      }
      return { default: MockAnthropic };
    });
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-key";

    try {
      const { generateConversationTitle } = await import(
        "@/lib/title-generator"
      );
      const result = await generateConversationTitle("   ");
      expect(result).toBeNull();
      expect(create).not.toHaveBeenCalled();
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it("returns a sanitised title on a successful SDK response", async () => {
    vi.doMock("@anthropic-ai/sdk", () => {
      class MockAnthropic {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [
              { type: "text", text: '**Title:** "Sorting a Python list"' },
            ],
          }),
        };
      }
      return { default: MockAnthropic };
    });
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-key";

    try {
      const { generateConversationTitle } = await import(
        "@/lib/title-generator"
      );
      const result = await generateConversationTitle("how do i sort a list");
      expect(result).toBe("Sorting a Python list");
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });
});
