import { describe, it, expect } from "vitest";
import { coerceModelId, RetiredModelError, RETIRED_MODELS } from "@/lib/retired-models";

describe("coerceModelId", () => {
  it("returns the original ID for current models", () => {
    expect(coerceModelId("gpt-5.4")).toBe("gpt-5.4");
    expect(coerceModelId("gpt-image-2")).toBe("gpt-image-2");
    expect(coerceModelId("claude-opus-4-7")).toBe("claude-opus-4-7");
  });

  it("maps retired Codex variants to gpt-5.3-codex", () => {
    expect(coerceModelId("gpt-5.1-codex")).toBe("gpt-5.3-codex");
    expect(coerceModelId("gpt-5.2-codex")).toBe("gpt-5.3-codex");
    expect(coerceModelId("gpt-5-codex")).toBe("gpt-5.3-codex");
  });

  it("maps gpt-5.1-codex-mini to gpt-5-mini", () => {
    expect(coerceModelId("gpt-5.1-codex-mini")).toBe("gpt-5-mini");
  });

  it("maps gpt-4.1-nano to gpt-5-nano", () => {
    expect(coerceModelId("gpt-4.1-nano")).toBe("gpt-5-nano");
  });

  it("maps gpt-image-1 to gpt-image-2", () => {
    expect(coerceModelId("gpt-image-1")).toBe("gpt-image-2");
  });

  it("maps the Nano Banana 2 preview to the GA gemini-3.1-flash-image", () => {
    expect(coerceModelId("gemini-3.1-flash-image-preview")).toBe(
      "gemini-3.1-flash-image"
    );
  });

  it("maps the Claude Opus 4.1 family to claude-opus-4-7", () => {
    expect(coerceModelId("claude-opus-4-1")).toBe("claude-opus-4-7");
    expect(coerceModelId("claude-opus-4-1-20250805")).toBe("claude-opus-4-7");
    expect(coerceModelId("claude-opus-4-1-20250610")).toBe("claude-opus-4-7");
  });

  it("throws RetiredModelError for sora-2 (no replacement)", () => {
    expect(() => coerceModelId("sora-2")).toThrow(RetiredModelError);
    expect(() => coerceModelId("sora-2-pro")).toThrow(RetiredModelError);
  });

  it("exposes the retired ID on the thrown error for user-facing messages", () => {
    try {
      coerceModelId("sora-2");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RetiredModelError);
      expect((err as RetiredModelError).retiredModelId).toBe("sora-2");
    }
  });

  it("every retirement maps either to a non-empty replacement string or null", () => {
    for (const [retiredId, replacement] of Object.entries(RETIRED_MODELS)) {
      if (replacement === null) continue;
      expect(typeof replacement).toBe("string");
      expect(replacement.length).toBeGreaterThan(0);
      expect(replacement).not.toBe(retiredId);
    }
  });
});
