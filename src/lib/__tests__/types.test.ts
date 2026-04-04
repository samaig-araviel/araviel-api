import { describe, it, expect } from "vitest";
import { SUPPORTED_PROVIDERS } from "@/lib/types";
import type { SupportedProvider, SSEEventType } from "@/lib/types";

describe("SUPPORTED_PROVIDERS", () => {
  it("contains exactly 5 providers", () => {
    expect(SUPPORTED_PROVIDERS.size).toBe(5);
  });

  it("includes openai", () => {
    expect(SUPPORTED_PROVIDERS.has("openai")).toBe(true);
  });

  it("includes anthropic", () => {
    expect(SUPPORTED_PROVIDERS.has("anthropic")).toBe(true);
  });

  it("includes google", () => {
    expect(SUPPORTED_PROVIDERS.has("google")).toBe(true);
  });

  it("includes perplexity", () => {
    expect(SUPPORTED_PROVIDERS.has("perplexity")).toBe(true);
  });

  it("includes stability", () => {
    expect(SUPPORTED_PROVIDERS.has("stability")).toBe(true);
  });

  it("does not include unsupported providers", () => {
    expect(SUPPORTED_PROVIDERS.has("mistral")).toBe(false);
    expect(SUPPORTED_PROVIDERS.has("deepseek")).toBe(false);
    expect(SUPPORTED_PROVIDERS.has("elevenlabs")).toBe(false);
  });
});
