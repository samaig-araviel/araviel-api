import { describe, it, expect } from "vitest";
import { calculateCost } from "@/lib/cost";
import type { TokenUsage } from "@/lib/types";

describe("calculateCost", () => {
  const baseUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    webSearchRequests: 0,
  };

  it("returns 0 for zero token usage", () => {
    expect(calculateCost("openai", "gpt-4o", baseUsage)).toBe(0);
  });

  it("calculates input token cost correctly", () => {
    const usage: TokenUsage = { ...baseUsage, inputTokens: 1_000_000 };
    const cost = calculateCost("openai", "gpt-4o", usage);
    // gpt-4o input: $2.5/M
    expect(cost).toBe(2.5);
  });

  it("calculates output token cost correctly", () => {
    const usage: TokenUsage = { ...baseUsage, outputTokens: 1_000_000 };
    const cost = calculateCost("openai", "gpt-4o", usage);
    // gpt-4o output: $10/M
    expect(cost).toBe(10);
  });

  it("calculates reasoning token cost at output rate", () => {
    const usage: TokenUsage = { ...baseUsage, reasoningTokens: 1_000_000 };
    const cost = calculateCost("openai", "o3", usage);
    // o3 output: $8/M
    expect(cost).toBe(8);
  });

  it("calculates combined input + output cost", () => {
    const usage: TokenUsage = {
      ...baseUsage,
      inputTokens: 500_000,
      outputTokens: 200_000,
    };
    const cost = calculateCost("openai", "gpt-4o", usage);
    // input: 0.5M * $2.5 = $1.25, output: 0.2M * $10 = $2
    expect(cost).toBe(3.25);
  });

  it("includes web search cost for anthropic", () => {
    const usage: TokenUsage = { ...baseUsage, webSearchRequests: 5 };
    const cost = calculateCost("anthropic", "claude-sonnet-4-6", usage);
    // 5 * $0.01 = $0.05
    expect(cost).toBe(0.05);
  });

  it("web search is free for openai", () => {
    const usage: TokenUsage = { ...baseUsage, webSearchRequests: 10 };
    const cost = calculateCost("openai", "gpt-4o", usage);
    expect(cost).toBe(0);
  });

  it("includes web search cost for google", () => {
    const usage: TokenUsage = { ...baseUsage, webSearchRequests: 2 };
    const cost = calculateCost("google", "gemini-2.5-pro", usage);
    // 2 * $0.035 = $0.07
    expect(cost).toBe(0.07);
  });

  it("handles small token counts without floating point issues", () => {
    const usage: TokenUsage = { ...baseUsage, inputTokens: 100, outputTokens: 50 };
    const cost = calculateCost("openai", "gpt-4o-mini", usage);
    // input: 100/1M * 0.15 = 0.000015, output: 50/1M * 0.6 = 0.00003
    expect(cost).toBeCloseTo(0.000045, 6);
  });

  it("returns a number with at most 6 decimal places", () => {
    const usage: TokenUsage = { ...baseUsage, inputTokens: 1, outputTokens: 1 };
    const cost = calculateCost("openai", "gpt-4o", usage);
    const decimalPlaces = cost.toString().split(".")[1]?.length ?? 0;
    expect(decimalPlaces).toBeLessThanOrEqual(6);
  });
});
