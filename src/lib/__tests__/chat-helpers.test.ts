import { describe, it, expect } from "vitest";
import {
  validateChatRequest,
  resolveModel,
  isImageGenerationModel,
  canModelGenerateImages,
  getImageCapableModels,
  resolveWebSearch,
  detectTimeSensitivePrompt,
  shouldEnableThinking,
  resolveThinking,
  applyThinkingProviderOverride,
  findThinkingAwareBackup,
  detectFileIntent,
  findSupportedBackup,
  buildSystemPromptParts,
  pruneOrphanUserMessages,
  attachImagesFromLastUserMessage,
} from "@/lib/chat-helpers";
import type { ADEResponse, ADEModelResult, ModelInfo } from "@/lib/types";

// ─── validateChatRequest ──────────────────────────────────────────────────────

describe("validateChatRequest", () => {
  it("parses a valid minimal request", () => {
    const result = validateChatRequest({ message: "Hello" });
    expect(result.message).toBe("Hello");
    expect(result.userTier).toBe("free");
    expect(result.modality).toBe("text");
  });

  it("trims the message", () => {
    const result = validateChatRequest({ message: "  hello  " });
    expect(result.message).toBe("hello");
  });

  it("throws for null body", () => {
    expect(() => validateChatRequest(null)).toThrow("Request body is required");
  });

  it("throws for non-object body", () => {
    expect(() => validateChatRequest("string")).toThrow(
      "Request body is required"
    );
  });

  it("throws for missing message", () => {
    expect(() => validateChatRequest({})).toThrow("message is required");
  });

  it("throws for empty message with no images", () => {
    expect(() => validateChatRequest({ message: "" })).toThrow(
      "message is required when no images are attached"
    );
  });

  it("throws for whitespace-only message with no images", () => {
    expect(() => validateChatRequest({ message: "   " })).toThrow(
      "message is required when no images are attached"
    );
  });

  it("throws for non-string message", () => {
    expect(() => validateChatRequest({ message: 123 })).toThrow(
      "message is required"
    );
  });

  it("accepts an empty message when images are attached", () => {
    const result = validateChatRequest({
      message: "",
      images: [
        {
          dataUri: "data:image/jpeg;base64,/9j/AAAA",
          mimeType: "image/jpeg",
          fileName: "a.jpg",
        },
      ],
    });
    expect(result.message).toBe("");
    expect(result.images).toHaveLength(1);
  });

  it("accepts a whitespace-only message when images are attached", () => {
    const result = validateChatRequest({
      message: "   ",
      images: [
        {
          dataUri: "data:image/png;base64,iVBORw0KAAAA",
          mimeType: "image/png",
        },
      ],
    });
    expect(result.message).toBe("");
    expect(result.images).toHaveLength(1);
  });

  it("parses optional string fields", () => {
    const result = validateChatRequest({
      message: "hi",
      conversationId: "conv-1",
      subConversationId: "sub-1",
      projectId: "proj-1",
      selectedModelId: "gpt-4o",
      tone: "friendly",
      mood: "happy",
      autoStrategy: "taskBased",
      weather: "sunny",
    });
    expect(result.conversationId).toBe("conv-1");
    expect(result.subConversationId).toBe("sub-1");
    expect(result.projectId).toBe("proj-1");
    expect(result.selectedModelId).toBe("gpt-4o");
    expect(result.tone).toBe("friendly");
    expect(result.mood).toBe("happy");
    expect(result.autoStrategy).toBe("taskBased");
    expect(result.weather).toBe("sunny");
  });

  it("ignores non-string optional fields", () => {
    const result = validateChatRequest({
      message: "hi",
      conversationId: 123,
      tone: null,
    });
    expect(result.conversationId).toBeUndefined();
    expect(result.tone).toBeUndefined();
  });

  it("parses imageQuality only if valid", () => {
    expect(
      validateChatRequest({ message: "hi", imageQuality: "hd" }).imageQuality
    ).toBe("hd");
    expect(
      validateChatRequest({ message: "hi", imageQuality: "ultra" }).imageQuality
    ).toBe("ultra");
    expect(
      validateChatRequest({ message: "hi", imageQuality: "standard" })
        .imageQuality
    ).toBe("standard");
    expect(
      validateChatRequest({ message: "hi", imageQuality: "invalid" })
        .imageQuality
    ).toBeUndefined();
  });

  it("parses webSearch boolean", () => {
    expect(
      validateChatRequest({ message: "hi", webSearch: true }).webSearch
    ).toBe(true);
    expect(
      validateChatRequest({ message: "hi", webSearch: false }).webSearch
    ).toBe(false);
    expect(
      validateChatRequest({ message: "hi", webSearch: "yes" }).webSearch
    ).toBeUndefined();
  });

  it("validates importedConversationId as UUID", () => {
    const validUUID = "550e8400-e29b-41d4-a716-446655440000";
    const result = validateChatRequest({
      message: "hi",
      importedConversationId: validUUID,
    });
    expect(result.importedConversationId).toBe(validUUID);
  });

  it("throws for invalid importedConversationId UUID", () => {
    expect(() =>
      validateChatRequest({
        message: "hi",
        importedConversationId: "not-a-uuid",
      })
    ).toThrow("valid UUID");
  });

  it("parses conversationHasImages boolean", () => {
    expect(
      validateChatRequest({ message: "hi", conversationHasImages: true })
        .conversationHasImages
    ).toBe(true);
  });
});

// ─── resolveModel ─────────────────────────────────────────────────────────────

function makeADEResult(
  id: string,
  provider: string,
  score = 90
): ADEModelResult {
  return {
    id,
    name: id,
    provider,
    score,
    reasoning: { summary: "test", factors: [] },
  };
}

function makeADEResponse(
  primary: ADEModelResult,
  backups: ADEModelResult[] = []
): ADEResponse {
  return {
    decisionId: "dec-1",
    primaryModel: primary,
    backupModels: backups,
    confidence: 0.95,
    analysis: {
      intent: "general",
      domain: "general",
      complexity: "moderate",
      tone: "neutral",
      modality: "text",
      keywords: [],
      humanContextUsed: false,
    },
    timing: {
      totalMs: 100,
      analysisMs: 30,
      scoringMs: 40,
      selectionMs: 30,
    },
  };
}

describe("resolveModel", () => {
  it("uses ADE primary model when no manual selection", () => {
    const ade = makeADEResponse(makeADEResult("gpt-4o", "openai"));
    const result = resolveModel(ade);
    expect(result.model.id).toBe("gpt-4o");
    expect(result.isManualSelection).toBe(false);
  });

  it("uses manually selected model from ADE results", () => {
    const ade = makeADEResponse(
      makeADEResult("gpt-4o", "openai"),
      [makeADEResult("claude-sonnet-4-6", "anthropic")]
    );
    const result = resolveModel(ade, "claude-sonnet-4-6");
    expect(result.model.id).toBe("claude-sonnet-4-6");
    expect(result.isManualSelection).toBe(true);
  });

  it("creates a model entry for manual selection not in ADE results", () => {
    const ade = makeADEResponse(makeADEResult("gpt-4o", "openai"));
    const result = resolveModel(ade, "some-custom-model");
    expect(result.model.id).toBe("some-custom-model");
    expect(result.model.reasoning).toBe("Manually selected by user");
    expect(result.isManualSelection).toBe(true);
  });

  it("guesses provider from model ID prefix", () => {
    const ade = makeADEResponse(makeADEResult("gpt-4o", "openai"));

    const claudeResult = resolveModel(ade, "claude-opus-4-6");
    expect(claudeResult.model.provider).toBe("anthropic");

    const geminiResult = resolveModel(ade, "gemini-2.5-pro");
    expect(geminiResult.model.provider).toBe("google");

    const sonarResult = resolveModel(ade, "sonar-pro");
    expect(sonarResult.model.provider).toBe("perplexity");

    const stableResult = resolveModel(ade, "stable-diffusion-3.5");
    expect(stableResult.model.provider).toBe("stability");

    const o3Result = resolveModel(ade, "o3");
    expect(o3Result.model.provider).toBe("openai");

    const o4Result = resolveModel(ade, "o4-mini");
    expect(o4Result.model.provider).toBe("openai");
  });

  it("falls back to supported backup when primary is unsupported", () => {
    const ade = makeADEResponse(
      makeADEResult("unsupported-model", "unsupported_provider"),
      [makeADEResult("gpt-4o", "openai")]
    );
    const result = resolveModel(ade);
    expect(result.model.id).toBe("gpt-4o");
    expect(result.isManualSelection).toBe(false);
  });

  it("throws when no supported provider is available", () => {
    const ade = makeADEResponse(
      makeADEResult("model-a", "unsupported_a"),
      [makeADEResult("model-b", "unsupported_b")]
    );
    expect(() => resolveModel(ade)).toThrow("No supported provider");
  });

  it("returns backup models alongside primary", () => {
    const ade = makeADEResponse(
      makeADEResult("gpt-4o", "openai"),
      [
        makeADEResult("claude-sonnet-4-6", "anthropic"),
        makeADEResult("gemini-2.5-pro", "google"),
      ]
    );
    const result = resolveModel(ade);
    expect(result.backupModels).toHaveLength(2);
  });
});

// ─── isImageGenerationModel ───────────────────────────────────────────────────

describe("isImageGenerationModel", () => {
  it("returns true for dedicated image models", () => {
    expect(isImageGenerationModel("gpt-image-2")).toBe(true);
    expect(isImageGenerationModel("gpt-image-1.5")).toBe(true);
    expect(isImageGenerationModel("gpt-image-1-mini")).toBe(true);
    expect(isImageGenerationModel("imagen-4")).toBe(true);
    expect(isImageGenerationModel("imagen-3")).toBe(true);
    expect(isImageGenerationModel("stable-diffusion-3.5")).toBe(true);
  });

  it("returns false for chat models", () => {
    expect(isImageGenerationModel("gpt-4o")).toBe(false);
    expect(isImageGenerationModel("claude-opus-4-6")).toBe(false);
    expect(isImageGenerationModel("gemini-2.5-pro")).toBe(false);
  });

  it("returns false for retired image model IDs", () => {
    expect(isImageGenerationModel("gpt-image-1")).toBe(false);
  });
});

// ─── canModelGenerateImages ───────────────────────────────────────────────────

describe("canModelGenerateImages", () => {
  it("returns true for dedicated image models", () => {
    expect(canModelGenerateImages("gpt-image-2")).toBe(true);
  });

  it("returns true for native image gen chat models", () => {
    expect(canModelGenerateImages("gpt-4o")).toBe(true);
    expect(canModelGenerateImages("gpt-4.1")).toBe(true);
    expect(canModelGenerateImages("gpt-5.2")).toBe(true);
  });

  it("returns false for non-image models", () => {
    expect(canModelGenerateImages("claude-opus-4-6")).toBe(false);
    expect(canModelGenerateImages("sonar")).toBe(false);
  });
});

// ─── getImageCapableModels ────────────────────────────────────────────────────

describe("getImageCapableModels", () => {
  it("returns dedicated and nativeChat arrays", () => {
    const result = getImageCapableModels();
    expect(result.dedicated.length).toBeGreaterThan(0);
    expect(result.nativeChat.length).toBeGreaterThan(0);
  });

  it("each model has id, name, and provider", () => {
    const result = getImageCapableModels();
    for (const model of [...result.dedicated, ...result.nativeChat]) {
      expect(model.id).toBeDefined();
      expect(model.name).toBeDefined();
      expect(model.provider).toBeDefined();
    }
  });
});

// ─── resolveWebSearch ─────────────────────────────────────────────────────────

describe("resolveWebSearch", () => {
  const baseAnalysis: ADEResponse["analysis"] = {
    intent: "general",
    domain: "general",
    complexity: "moderate",
    tone: "neutral",
    modality: "text",
    keywords: [],
    humanContextUsed: false,
  };

  it("returns true when user explicitly enabled", () => {
    const result = resolveWebSearch(true, baseAnalysis);
    expect(result.shouldUseWebSearch).toBe(true);
    expect(result.webSearchAutoDetected).toBe(false);
  });

  it("returns false when user explicitly disabled", () => {
    const result = resolveWebSearch(false, baseAnalysis);
    expect(result.shouldUseWebSearch).toBe(false);
    expect(result.webSearchAutoDetected).toBe(false);
  });

  it("auto-detects from ADE webSearchRequired", () => {
    const analysis = { ...baseAnalysis, webSearchRequired: true };
    const result = resolveWebSearch(undefined, analysis);
    expect(result.shouldUseWebSearch).toBe(true);
    expect(result.webSearchAutoDetected).toBe(true);
  });

  it("auto-detects from research intent", () => {
    const analysis = { ...baseAnalysis, intent: "research" };
    const result = resolveWebSearch(undefined, analysis);
    expect(result.shouldUseWebSearch).toBe(true);
    expect(result.webSearchAutoDetected).toBe(true);
  });

  it("auto-detects from current_events intent", () => {
    const analysis = { ...baseAnalysis, intent: "current_events" };
    const result = resolveWebSearch(undefined, analysis);
    expect(result.shouldUseWebSearch).toBe(true);
    expect(result.webSearchAutoDetected).toBe(true);
  });

  it("does not auto-detect for coding intent", () => {
    const analysis = { ...baseAnalysis, intent: "coding" };
    const result = resolveWebSearch(undefined, analysis);
    expect(result.shouldUseWebSearch).toBe(false);
    expect(result.webSearchAutoDetected).toBe(false);
  });

  it("auto-detects time-sensitive prompts ADE missed", () => {
    const result = resolveWebSearch(undefined, baseAnalysis, "london weather");
    expect(result.shouldUseWebSearch).toBe(true);
    expect(result.webSearchAutoDetected).toBe(true);
  });

  it("does not override an explicit user opt-out", () => {
    const result = resolveWebSearch(false, baseAnalysis, "weather in tokyo");
    expect(result.shouldUseWebSearch).toBe(false);
    expect(result.webSearchAutoDetected).toBe(false);
  });

  it("inherits web search for a short follow-up in a live-data conversation", () => {
    const result = resolveWebSearch(
      undefined,
      baseAnalysis,
      "Hourly table for Maidstone",
      true
    );
    expect(result.shouldUseWebSearch).toBe(true);
    expect(result.webSearchAutoDetected).toBe(true);
  });

  it("does not inherit for long prompts (likely a new topic)", () => {
    const longPrompt =
      "Explain in detail how transformer attention works, including the math, " +
      "the role of query/key/value matrices, and why scaled dot-product attention " +
      "matters in practice when training large language models.";
    const result = resolveWebSearch(undefined, baseAnalysis, longPrompt, true);
    expect(result.shouldUseWebSearch).toBe(false);
    expect(result.webSearchAutoDetected).toBe(false);
  });

  it("does not inherit when the previous turn did not use search", () => {
    const result = resolveWebSearch(undefined, baseAnalysis, "and Birmingham?", false);
    expect(result.shouldUseWebSearch).toBe(false);
    expect(result.webSearchAutoDetected).toBe(false);
  });
});

// ─── detectTimeSensitivePrompt ────────────────────────────────────────────────

describe("detectTimeSensitivePrompt", () => {
  it("matches weather queries", () => {
    expect(detectTimeSensitivePrompt("london weather")).toBe(true);
    expect(detectTimeSensitivePrompt("What's the weather in Tokyo?")).toBe(true);
    expect(detectTimeSensitivePrompt("weekly forecast for Berlin")).toBe(true);
  });

  it("matches news queries", () => {
    expect(detectTimeSensitivePrompt("breaking news")).toBe(true);
    expect(detectTimeSensitivePrompt("latest news on the election")).toBe(true);
    expect(detectTimeSensitivePrompt("show me the headlines")).toBe(true);
  });

  it("matches finance queries", () => {
    expect(detectTimeSensitivePrompt("AAPL stock price")).toBe(true);
    expect(detectTimeSensitivePrompt("bitcoin price right now")).toBe(true);
    expect(detectTimeSensitivePrompt("USD to EUR exchange rate")).toBe(true);
  });

  it("matches live-result queries", () => {
    expect(detectTimeSensitivePrompt("who won the game last night")).toBe(true);
    expect(detectTimeSensitivePrompt("final score of the Lakers game")).toBe(true);
  });

  it("ignores prompts with fenced code blocks", () => {
    const prompt = "Debug this weather widget:\n```js\nconst w = getWeather();\n```";
    expect(detectTimeSensitivePrompt(prompt)).toBe(false);
  });

  it("ignores very long prompts likely to be code or discussion", () => {
    const prompt = "weather " + "x".repeat(600);
    expect(detectTimeSensitivePrompt(prompt)).toBe(false);
  });

  it("ignores unrelated prompts", () => {
    expect(detectTimeSensitivePrompt("how do I sort a list in python")).toBe(false);
    expect(detectTimeSensitivePrompt("write a haiku about autumn")).toBe(false);
    expect(detectTimeSensitivePrompt("")).toBe(false);
  });
});

// ─── shouldEnableThinking ─────────────────────────────────────────────────────

describe("shouldEnableThinking", () => {
  const baseAnalysis: ADEResponse["analysis"] = {
    intent: "general",
    domain: "general",
    complexity: "moderate",
    tone: "neutral",
    modality: "text",
    keywords: [],
    humanContextUsed: false,
  };

  it("returns true for demanding complexity", () => {
    expect(
      shouldEnableThinking({ ...baseAnalysis, complexity: "demanding" })
    ).toBe(true);
  });

  it("returns false for moderate complexity", () => {
    expect(
      shouldEnableThinking({ ...baseAnalysis, complexity: "moderate" })
    ).toBe(false);
  });

  it("returns false for simple complexity", () => {
    expect(
      shouldEnableThinking({ ...baseAnalysis, complexity: "simple" })
    ).toBe(false);
  });
});

// ─── resolveThinking ──────────────────────────────────────────────────────────

describe("resolveThinking", () => {
  const standardAnalysis: ADEResponse["analysis"] = {
    intent: "general",
    domain: "general",
    complexity: "standard",
    tone: "neutral",
    modality: "text",
    keywords: [],
    humanContextUsed: false,
  };
  const demandingAnalysis: ADEResponse["analysis"] = {
    ...standardAnalysis,
    complexity: "demanding",
  };

  it("falls back to ADE when no user preference is set", () => {
    expect(resolveThinking(standardAnalysis, "anthropic", {})).toBe(false);
    expect(resolveThinking(demandingAnalysis, "anthropic", {})).toBe(true);
  });

  it("forces thinking on when extendedThinking matches an Anthropic model", () => {
    expect(
      resolveThinking(standardAnalysis, "anthropic", { extendedThinking: true })
    ).toBe(true);
  });

  it("forces thinking on when deepResearch matches an OpenAI model", () => {
    expect(
      resolveThinking(standardAnalysis, "openai", { deepResearch: true })
    ).toBe(true);
  });

  it("forces thinking on when googleThinking matches a Google model", () => {
    expect(
      resolveThinking(standardAnalysis, "google", { googleThinking: true })
    ).toBe(true);
  });

  it("ignores a toggle that targets a different provider", () => {
    expect(
      resolveThinking(standardAnalysis, "openai", { extendedThinking: true })
    ).toBe(false);
    expect(
      resolveThinking(standardAnalysis, "google", { deepResearch: true })
    ).toBe(false);
    expect(
      resolveThinking(standardAnalysis, "anthropic", { googleThinking: true })
    ).toBe(false);
  });

  it("still falls through to ADE when a non-matching toggle is set", () => {
    expect(
      resolveThinking(demandingAnalysis, "openai", { extendedThinking: true })
    ).toBe(true);
  });
});

// ─── applyThinkingProviderOverride ────────────────────────────────────────────

describe("applyThinkingProviderOverride", () => {
  const makeModel = (id: string, provider: string): ModelInfo => ({
    id,
    name: id,
    provider,
    score: 1,
    reasoning: "",
  });

  const allProviders = ["openai", "anthropic", "google", "perplexity"];

  it("returns the resolved model unchanged when no toggle is set", () => {
    const resolved = {
      model: makeModel("sonar", "perplexity"),
      backupModels: [makeModel("claude-opus-4-7", "anthropic")],
      isManualSelection: false,
    };
    const out = applyThinkingProviderOverride(resolved, {}, allProviders);
    expect(out.model.id).toBe("sonar");
    expect(out.overriddenForProvider).toBeUndefined();
  });

  it("swaps to a backup of the requested provider when ADE picked elsewhere", () => {
    const sonar = makeModel("sonar-deep-research", "perplexity");
    const claude = makeModel("claude-opus-4-7", "anthropic");
    const resolved = {
      model: sonar,
      backupModels: [claude, makeModel("gpt-5.2", "openai")],
      isManualSelection: false,
    };

    const out = applyThinkingProviderOverride(
      resolved,
      { extendedThinking: true },
      allProviders
    );

    expect(out.model.id).toBe("claude-opus-4-7");
    expect(out.overriddenForProvider).toBe("anthropic");
    // Demoted primary should be retained as the new top backup
    expect(out.backupModels[0]?.id).toBe("sonar-deep-research");
  });

  it("falls back to a default thinking model when no backup matches the provider", () => {
    const resolved = {
      model: makeModel("sonar-deep-research", "perplexity"),
      backupModels: [makeModel("gpt-5.2", "openai")],
      isManualSelection: false,
    };
    const out = applyThinkingProviderOverride(
      resolved,
      { googleThinking: true },
      allProviders
    );
    expect(out.model.provider).toBe("google");
    expect(out.model.id).toBe("gemini-3-pro");
    expect(out.overriddenForProvider).toBe("google");
  });

  it("falls back to the deep-research default rather than a non-DR OpenAI backup", () => {
    // Deep Research toggle requires a DR model; gpt-5.2 is OpenAI but is not
    // a DR model, so swapping to it would silently downgrade the toggle.
    const resolved = {
      model: makeModel("sonar", "perplexity"),
      backupModels: [makeModel("gpt-5.2", "openai")],
      isManualSelection: false,
    };
    const out = applyThinkingProviderOverride(
      resolved,
      { deepResearch: true },
      allProviders
    );
    expect(out.model.id).toBe("o3-deep-research");
    expect(out.overriddenForProvider).toBe("openai");
  });

  it("prefers a thinking-capable OpenAI backup over the default", () => {
    const resolved = {
      model: makeModel("sonar", "perplexity"),
      backupModels: [
        makeModel("gpt-5.2", "openai"),
        makeModel("o4-mini-deep-research", "openai"),
      ],
      isManualSelection: false,
    };
    const out = applyThinkingProviderOverride(
      resolved,
      { deepResearch: true },
      allProviders
    );
    expect(out.model.id).toBe("o4-mini-deep-research");
    expect(out.overriddenForProvider).toBe("openai");
  });

  it("falls back to default Claude when ADE only offers a non-thinking Claude model", () => {
    // claude-3-5-haiku is Anthropic but not in the thinking set; using it
    // would silently disable the toggle. Override must escalate to a
    // thinking-capable Claude.
    const resolved = {
      model: makeModel("sonar", "perplexity"),
      backupModels: [makeModel("claude-haiku-4-5-20251001", "anthropic")],
      isManualSelection: false,
    };
    const out = applyThinkingProviderOverride(
      resolved,
      { extendedThinking: true },
      allProviders
    );
    expect(out.model.id).toBe("claude-opus-4-7");
    expect(out.overriddenForProvider).toBe("anthropic");
  });

  it("escalates to default when the primary is the same provider but not thinking-capable", () => {
    const resolved = {
      model: makeModel("claude-haiku-4-5-20251001", "anthropic"),
      backupModels: [],
      isManualSelection: false,
    };
    const out = applyThinkingProviderOverride(
      resolved,
      { extendedThinking: true },
      allProviders
    );
    expect(out.model.id).toBe("claude-opus-4-7");
    expect(out.overriddenForProvider).toBe("anthropic");
  });

  it("keeps the original model when ADE already picked a thinking-capable model from the requested provider", () => {
    const resolved = {
      model: makeModel("claude-sonnet-4-6", "anthropic"),
      backupModels: [makeModel("gpt-5.2", "openai")],
      isManualSelection: false,
    };
    const out = applyThinkingProviderOverride(
      resolved,
      { extendedThinking: true },
      allProviders
    );
    expect(out.model.id).toBe("claude-sonnet-4-6");
    expect(out.overriddenForProvider).toBeUndefined();
  });

  it("does not override when the user manually selected a model", () => {
    const resolved = {
      model: makeModel("sonar", "perplexity"),
      backupModels: [makeModel("claude-opus-4-7", "anthropic")],
      isManualSelection: true,
    };
    const out = applyThinkingProviderOverride(
      resolved,
      { extendedThinking: true },
      allProviders
    );
    expect(out.model.id).toBe("sonar");
    expect(out.overriddenForProvider).toBeUndefined();
  });

  it("does not override when the requested provider is not configured", () => {
    const resolved = {
      model: makeModel("sonar", "perplexity"),
      backupModels: [makeModel("gpt-5.2", "openai")],
      isManualSelection: false,
    };
    const out = applyThinkingProviderOverride(
      resolved,
      { extendedThinking: true },
      ["openai", "perplexity"] // anthropic missing
    );
    expect(out.model.id).toBe("sonar");
    expect(out.overriddenForProvider).toBeUndefined();
  });
});

// ─── detectFileIntent ─────────────────────────────────────────────────────────

describe("detectFileIntent", () => {
  it("detects 'download as pdf'", () => {
    expect(detectFileIntent("download as pdf")).toBe(true);
  });

  it("detects 'export to word'", () => {
    expect(detectFileIntent("export to word")).toBe(true);
  });

  it("detects 'save as xlsx'", () => {
    expect(detectFileIntent("save as xlsx")).toBe(true);
  });

  it("detects 'give me a pdf'", () => {
    expect(detectFileIntent("give me a pdf")).toBe(true);
  });

  it("detects 'create a spreadsheet'", () => {
    expect(detectFileIntent("create a spreadsheet")).toBe(true);
  });

  it("detects 'generate a powerpoint'", () => {
    expect(detectFileIntent("generate a powerpoint")).toBe(true);
  });

  it("detects 'convert it to pdf'", () => {
    expect(detectFileIntent("please convert it to pdf for me")).toBe(true);
    expect(detectFileIntent("convert this to word please")).toBe(true);
  });

  it("detects 'make me a csv'", () => {
    expect(detectFileIntent("make me a csv")).toBe(true);
  });

  it("does not detect normal messages", () => {
    expect(detectFileIntent("What is the capital of France?")).toBe(false);
    expect(detectFileIntent("Help me write a function")).toBe(false);
    expect(detectFileIntent("Explain React hooks")).toBe(false);
  });
});

// ─── findSupportedBackup ──────────────────────────────────────────────────────

describe("findSupportedBackup", () => {
  it("returns first backup with supported provider", () => {
    const backups: ModelInfo[] = [
      {
        id: "model-a",
        name: "A",
        provider: "unsupported_provider",
        score: 80,
        reasoning: "",
      },
      { id: "gpt-4o", name: "GPT-4o", provider: "openai", score: 85, reasoning: "" },
    ];
    const result = findSupportedBackup(backups);
    expect(result?.id).toBe("gpt-4o");
  });

  it("returns undefined when no supported backup", () => {
    const backups: ModelInfo[] = [
      {
        id: "model-a",
        name: "A",
        provider: "unsupported",
        score: 80,
        reasoning: "",
      },
    ];
    expect(findSupportedBackup(backups)).toBeUndefined();
  });

  it("returns undefined for empty array", () => {
    expect(findSupportedBackup([])).toBeUndefined();
  });
});

// ─── findThinkingAwareBackup ──────────────────────────────────────────────────

describe("findThinkingAwareBackup", () => {
  const makeModel = (id: string, provider: string): ModelInfo => ({
    id,
    name: id,
    provider,
    score: 1,
    reasoning: "",
  });

  const allProviders = ["openai", "anthropic", "google", "perplexity"];

  it("behaves like findSupportedBackup when no toggle is set", () => {
    const backups = [
      makeModel("claude-haiku-4-5-20251001", "anthropic"),
      makeModel("gpt-5.2", "openai"),
    ];
    const result = findThinkingAwareBackup(backups, {}, allProviders);
    expect(result?.backup.id).toBe("claude-haiku-4-5-20251001");
    expect(result?.modeHonored).toBe(true);
    expect(result?.downgradedFrom).toBeNull();
  });

  it("prefers a thinking-capable backup matching the toggle's provider", () => {
    const backups = [
      makeModel("gpt-5.2", "openai"),
      makeModel("claude-opus-4-7", "anthropic"),
    ];
    const result = findThinkingAwareBackup(
      backups,
      { extendedThinking: true },
      allProviders
    );
    expect(result?.backup.id).toBe("claude-opus-4-7");
    expect(result?.modeHonored).toBe(true);
    expect(result?.downgradedFrom).toBeNull();
  });

  it("downgrades when only a non-thinking-capable same-provider backup exists", () => {
    // claude-3-5-haiku is Anthropic but not in the thinking set — picking it
    // would silently disable the toggle, so the helper falls through to any
    // supported backup and reports the downgrade.
    const backups = [
      makeModel("claude-haiku-4-5-20251001", "anthropic"),
      makeModel("gpt-5.2", "openai"),
    ];
    const result = findThinkingAwareBackup(
      backups,
      { extendedThinking: true },
      allProviders
    );
    expect(result?.backup.id).toBe("claude-haiku-4-5-20251001");
    expect(result?.modeHonored).toBe(false);
    expect(result?.downgradedFrom).toBe("anthropic");
  });

  it("downgrades when no matching-provider backup exists at all", () => {
    const backups = [
      makeModel("gpt-5.2", "openai"),
      makeModel("gemini-3-pro", "google"),
    ];
    const result = findThinkingAwareBackup(
      backups,
      { extendedThinking: true },
      allProviders
    );
    expect(result?.backup.id).toBe("gpt-5.2");
    expect(result?.modeHonored).toBe(false);
    expect(result?.downgradedFrom).toBe("anthropic");
  });

  it("ignores the toggle when the requested provider is unavailable", () => {
    const backups = [
      makeModel("gpt-5.2", "openai"),
      makeModel("claude-opus-4-7", "anthropic"),
    ];
    const result = findThinkingAwareBackup(
      backups,
      { extendedThinking: true },
      ["openai"] // anthropic not configured
    );
    expect(result?.backup.id).toBe("gpt-5.2");
    expect(result?.modeHonored).toBe(true);
    expect(result?.downgradedFrom).toBeNull();
  });

  it("honors the Deep Research toggle and prefers a DR model over plain OpenAI", () => {
    const backups = [
      makeModel("gpt-5.2", "openai"),
      makeModel("o3-deep-research", "openai"),
    ];
    const result = findThinkingAwareBackup(
      backups,
      { deepResearch: true },
      allProviders
    );
    expect(result?.backup.id).toBe("o3-deep-research");
    expect(result?.modeHonored).toBe(true);
  });

  it("returns undefined when no supported backup exists", () => {
    expect(
      findThinkingAwareBackup(
        [makeModel("foo", "unsupported")],
        { extendedThinking: true },
        allProviders
      )
    ).toBeUndefined();
  });

  it("returns undefined for empty backup list", () => {
    expect(
      findThinkingAwareBackup([], { extendedThinking: true }, allProviders)
    ).toBeUndefined();
  });
});

// ─── buildSystemPromptParts ───────────────────────────────────────────────────
//
// These tests lock in the contract that the prompt-caching implementation
// depends on: the `stable` block must be byte-identical across requests
// that share the same flags, and per-request / per-user / per-project
// content must live in `variable` (after the cache breakpoint), never in
// `stable`. If you change these tests, audit `buildSystemPromptParts` for
// silent invalidators (timestamps, UUIDs, non-deterministic serialization)
// before approving the change.

describe("buildSystemPromptParts", () => {
  it("produces byte-identical stable output across calls with the same flags", () => {
    const a = buildSystemPromptParts(undefined, {});
    const b = buildSystemPromptParts(undefined, {});
    expect(a.stable).toBe(b.stable);
  });

  it("produces byte-identical stable output regardless of project / user / title", () => {
    const a = buildSystemPromptParts(undefined, {});
    const b = buildSystemPromptParts("Some project rules", {
      includeTitleInstructions: true,
      userSettings: {
        customInstructions: "Always cite sources",
        responseTone: "professional",
        preferredLanguage: "English",
      },
    });
    // Variable parts differ between (a) and (b) — but the stable prefix
    // (the part marked with cache_control) must be identical, or the
    // cache cannot be shared across these requests.
    expect(a.stable).toBe(b.stable);
  });

  it("includes file-block instructions in stable when the flag is set", () => {
    const withFiles = buildSystemPromptParts(undefined, { includeFileInstructions: true });
    const withoutFiles = buildSystemPromptParts(undefined, { includeFileInstructions: false });
    expect(withFiles.stable).not.toBe(withoutFiles.stable);
    expect(withFiles.stable).toContain("File");
  });

  it("places title instructions in variable, not stable", () => {
    const withTitle = buildSystemPromptParts(undefined, { includeTitleInstructions: true });
    const withoutTitle = buildSystemPromptParts(undefined, {});
    // Stable must be identical so the cached prefix is reused across
    // new-conversation and continuing-conversation requests.
    expect(withTitle.stable).toBe(withoutTitle.stable);
    // Title content lands in the variable section.
    expect(withTitle.variable).toContain("<araviel_title>");
    expect(withoutTitle.variable).toBeUndefined();
  });

  it("places project instructions in variable, not stable", () => {
    const withProject = buildSystemPromptParts("Use TypeScript only");
    expect(withProject.stable).not.toContain("Use TypeScript only");
    expect(withProject.variable).toContain("Use TypeScript only");
    expect(withProject.variable).toContain("--- Project Instructions ---");
  });

  it("places user preferences in variable, not stable", () => {
    const withPrefs = buildSystemPromptParts(undefined, {
      userSettings: {
        responseTone: "candid",
        occupation: "engineer",
        preferredLanguage: "English",
      },
    });
    expect(withPrefs.stable).not.toContain("--- User Preferences ---");
    expect(withPrefs.variable).toContain("--- User Preferences ---");
    expect(withPrefs.variable).toContain("engineer");
  });

  it("returns undefined variable when no variable content is present", () => {
    const result = buildSystemPromptParts(undefined, {});
    expect(result.variable).toBeUndefined();
  });

  it("orders variable content: title, then project, then user prefs", () => {
    const result = buildSystemPromptParts("Project rules here", {
      includeTitleInstructions: true,
      userSettings: { responseTone: "professional", preferredLanguage: "English" },
    });
    const v = result.variable ?? "";
    const titleIdx = v.indexOf("<araviel_title>");
    const projectIdx = v.indexOf("--- Project Instructions ---");
    const prefsIdx = v.indexOf("--- User Preferences ---");
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(projectIdx).toBeGreaterThan(titleIdx);
    expect(prefsIdx).toBeGreaterThan(projectIdx);
  });
});

describe("pruneOrphanUserMessages", () => {
  it("returns the input unchanged when there are 0 or 1 messages", () => {
    expect(pruneOrphanUserMessages([])).toEqual([]);
    expect(pruneOrphanUserMessages([{ role: "user", content: "only" }])).toEqual([
      { role: "user", content: "only" },
    ]);
  });

  it("keeps a clean alternating conversation intact", () => {
    const conv = [
      { role: "user" as const, content: "u1" },
      { role: "assistant" as const, content: "a1" },
      { role: "user" as const, content: "u2" },
      { role: "assistant" as const, content: "a2" },
    ];
    expect(pruneOrphanUserMessages(conv)).toEqual(conv);
  });

  it("drops a user message immediately followed by another user message", () => {
    const conv = [
      { role: "user" as const, content: "u1" },
      { role: "assistant" as const, content: "a1" },
      { role: "user" as const, content: "u2-failed" },
      { role: "user" as const, content: "u3-current" },
    ];
    expect(pruneOrphanUserMessages(conv)).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u3-current" },
    ]);
  });

  it("drops multiple consecutive orphan user messages but keeps the last", () => {
    const conv = [
      { role: "user" as const, content: "u1-failed" },
      { role: "user" as const, content: "u2-failed" },
      { role: "user" as const, content: "u3-current" },
    ];
    expect(pruneOrphanUserMessages(conv)).toEqual([
      { role: "user", content: "u3-current" },
    ]);
  });

  it("keeps a system message that precedes orphan user messages", () => {
    const conv = [
      { role: "system" as const, content: "context" },
      { role: "user" as const, content: "u1-failed" },
      { role: "user" as const, content: "u2-current" },
    ];
    expect(pruneOrphanUserMessages(conv)).toEqual([
      { role: "system", content: "context" },
      { role: "user", content: "u2-current" },
    ]);
  });

  it("does not drop a trailing user message that has no follower", () => {
    const conv = [
      { role: "user" as const, content: "u1" },
      { role: "assistant" as const, content: "a1" },
      { role: "user" as const, content: "u2-current" },
    ];
    expect(pruneOrphanUserMessages(conv)).toEqual(conv);
  });
});

describe("attachImagesFromLastUserMessage", () => {
  const image = {
    dataUri: "data:image/jpeg;base64,AAAA",
    mimeType: "image/jpeg",
    fileName: "a.jpg",
  };

  it("attaches images to the most recent user message that originally carried them", () => {
    const messages = [
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "look at this" },
    ];
    const rows = [
      { role: "user", content: "first", attachments: null },
      { role: "assistant", content: "ok", attachments: null },
      { role: "user", content: "look at this", attachments: [image] },
    ];
    attachImagesFromLastUserMessage(messages, rows);
    expect(messages[2].images).toEqual([image]);
    expect(messages[0].images).toBeUndefined();
  });

  it("substitutes a placeholder for an earlier image-only user message whose images were stripped", () => {
    const messages = [
      { role: "user" as const, content: "" },
      { role: "assistant" as const, content: "Sure, what next?" },
      { role: "user" as const, content: "now compare with this" },
    ];
    const rows = [
      { role: "user", content: "", attachments: [image] },
      { role: "assistant", content: "Sure, what next?", attachments: null },
      { role: "user", content: "now compare with this", attachments: [image] },
    ];
    attachImagesFromLastUserMessage(messages, rows);
    expect(messages[2].images).toEqual([image]);
    expect(messages[0].images).toBeUndefined();
    expect(messages[0].content).toBe("[image]");
  });

  it("pluralizes the placeholder when the earlier message had multiple images", () => {
    const messages = [
      { role: "user" as const, content: "  " },
      { role: "user" as const, content: "next" },
    ];
    const rows = [
      { role: "user", content: "  ", attachments: [image, image, image] },
      { role: "user", content: "next", attachments: [image] },
    ];
    attachImagesFromLastUserMessage(messages, rows);
    expect(messages[0].content).toBe("[3 images]");
  });

  it("leaves earlier image-carrying user messages alone when they already have text", () => {
    const messages = [
      { role: "user" as const, content: "Original prompt with text" },
      { role: "user" as const, content: "next" },
    ];
    const rows = [
      { role: "user", content: "Original prompt with text", attachments: [image] },
      { role: "user", content: "next", attachments: [image] },
    ];
    attachImagesFromLastUserMessage(messages, rows);
    expect(messages[0].content).toBe("Original prompt with text");
  });

  it("is a no-op when no user message carried attachments", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    const rows = [
      { role: "user", content: "hi", attachments: null },
      { role: "assistant", content: "hello", attachments: null },
    ];
    attachImagesFromLastUserMessage(messages, rows);
    expect(messages[0].images).toBeUndefined();
    expect(messages[0].content).toBe("hi");
  });
});
