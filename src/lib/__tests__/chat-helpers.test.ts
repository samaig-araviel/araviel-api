import { describe, it, expect } from "vitest";
import {
  validateChatRequest,
  resolveModel,
  isImageGenerationModel,
  canModelGenerateImages,
  getImageCapableModels,
  resolveWebSearch,
  shouldEnableThinking,
  detectFileIntent,
  findSupportedBackup,
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

  it("throws for empty message", () => {
    expect(() => validateChatRequest({ message: "" })).toThrow(
      "message is required"
    );
  });

  it("throws for whitespace-only message", () => {
    expect(() => validateChatRequest({ message: "   " })).toThrow(
      "message is required"
    );
  });

  it("throws for non-string message", () => {
    expect(() => validateChatRequest({ message: 123 })).toThrow(
      "message is required"
    );
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
    expect(isImageGenerationModel("dall-e-3")).toBe(true);
    expect(isImageGenerationModel("gpt-image-1")).toBe(true);
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
});

// ─── canModelGenerateImages ───────────────────────────────────────────────────

describe("canModelGenerateImages", () => {
  it("returns true for dedicated image models", () => {
    expect(canModelGenerateImages("dall-e-3")).toBe(true);
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
