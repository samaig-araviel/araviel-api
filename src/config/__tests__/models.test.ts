import { describe, it, expect } from "vitest";
import { getModelPricing } from "@/config/models";

describe("getModelPricing", () => {
  describe("exact model ID matches", () => {
    it("returns correct pricing for claude-opus-4-6", () => {
      const pricing = getModelPricing("claude-opus-4-6", "anthropic");
      expect(pricing.inputPerMillion).toBe(5);
      expect(pricing.outputPerMillion).toBe(25);
    });

    it("returns correct pricing for gpt-4o", () => {
      const pricing = getModelPricing("gpt-4o", "openai");
      expect(pricing.inputPerMillion).toBe(2.5);
      expect(pricing.outputPerMillion).toBe(10);
    });

    it("returns correct pricing for gpt-4o-mini", () => {
      const pricing = getModelPricing("gpt-4o-mini", "openai");
      expect(pricing.inputPerMillion).toBe(0.15);
      expect(pricing.outputPerMillion).toBe(0.6);
    });

    it("returns correct pricing for gemini-2.5-pro", () => {
      const pricing = getModelPricing("gemini-2.5-pro", "google");
      expect(pricing.inputPerMillion).toBe(1.25);
      expect(pricing.outputPerMillion).toBe(10);
    });

    it("returns correct pricing for sonar", () => {
      const pricing = getModelPricing("sonar", "perplexity");
      expect(pricing.inputPerMillion).toBe(1);
      expect(pricing.outputPerMillion).toBe(1);
    });

    it("returns correct pricing for sonar-pro", () => {
      const pricing = getModelPricing("sonar-pro", "perplexity");
      expect(pricing.inputPerMillion).toBe(3);
      expect(pricing.outputPerMillion).toBe(15);
    });

    it("returns correct pricing for o3", () => {
      const pricing = getModelPricing("o3", "openai");
      expect(pricing.inputPerMillion).toBe(2);
      expect(pricing.outputPerMillion).toBe(8);
    });

    it("returns correct pricing for image models", () => {
      const pricing = getModelPricing("dall-e-3", "openai");
      expect(pricing.inputPerMillion).toBe(40);
      expect(pricing.outputPerMillion).toBe(80);
    });
  });

  describe("prefix/partial matching", () => {
    it("matches model IDs that start with a known key", () => {
      const pricing = getModelPricing("claude-opus-4-6-extended", "anthropic");
      expect(pricing.inputPerMillion).toBe(5);
      expect(pricing.outputPerMillion).toBe(25);
    });
  });

  describe("provider fallback", () => {
    it("falls back to openai default for unknown openai model", () => {
      const pricing = getModelPricing("gpt-unknown-future", "openai");
      expect(pricing.inputPerMillion).toBe(2);
      expect(pricing.outputPerMillion).toBe(8);
    });

    it("falls back to anthropic default for unknown anthropic model", () => {
      const pricing = getModelPricing("claude-unknown", "anthropic");
      expect(pricing.inputPerMillion).toBe(3);
      expect(pricing.outputPerMillion).toBe(15);
    });

    it("falls back to google default for unknown google model", () => {
      const pricing = getModelPricing("gemini-unknown", "google");
      expect(pricing.inputPerMillion).toBe(1.25);
      expect(pricing.outputPerMillion).toBe(10);
    });

    it("falls back to perplexity default for unknown perplexity model", () => {
      const pricing = getModelPricing("perplexity-unknown", "perplexity");
      expect(pricing.inputPerMillion).toBe(1);
      expect(pricing.outputPerMillion).toBe(1);
    });
  });

  describe("global fallback", () => {
    it("falls back to global default for completely unknown provider", () => {
      const pricing = getModelPricing("unknown-model", "unknown-provider");
      expect(pricing.inputPerMillion).toBe(2);
      expect(pricing.outputPerMillion).toBe(10);
    });
  });
});
