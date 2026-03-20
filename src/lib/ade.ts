import type { ADEResponse } from "@/lib/types";

interface ADERequestContext {
  conversationId?: string;
  previousModelUsed?: string;
}

interface ADEHumanContext {
  emotionalState?: { mood?: string };
  environmentalContext?: { weather?: string };
  preferences?: { tone?: string };
}

interface ADEConstraints {
  maxCostPer1kTokens?: number;
}

interface ADERequest {
  prompt: string;
  modality: string;
  userTier: string;
  availableProviders?: string[];
  context?: ADERequestContext;
  humanContext?: ADEHumanContext;
  constraints?: ADEConstraints;
  tone?: string;
  conversationHasImages?: boolean;
}

interface ADECallResult {
  response: ADEResponse;
  latencyMs: number;
}

const ADE_TIMEOUT_MS = 15_000; // 15 seconds per attempt
const ADE_MAX_RETRIES = 1; // 1 retry = 2 total attempts
const ADE_RETRY_DELAY_MS = 500;

async function fetchADEOnce(
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Response> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return res;
}

export async function callADE(request: ADERequest): Promise<ADECallResult> {
  const baseUrl = process.env.ADE_BASE_URL ?? "https://ade-sandy.vercel.app";
  const url = `${baseUrl}/api/v1/route`;

  const body: Record<string, unknown> = {
    prompt: request.prompt,
    modality: request.modality,
    userTier: request.userTier,
  };

  if (request.availableProviders && request.availableProviders.length > 0) {
    body.availableProviders = request.availableProviders;
  }

  if (request.context?.conversationId || request.context?.previousModelUsed) {
    body.context = {
      conversationId: request.context.conversationId,
      previousModelUsed: request.context.previousModelUsed,
    };
  }

  if (request.humanContext) {
    body.humanContext = request.humanContext;
  }

  if (request.constraints) {
    body.constraints = request.constraints;
  }

  if (request.tone) {
    body.tone = request.tone;
  }

  if (request.conversationHasImages) {
    body.conversationHasImages = true;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= ADE_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, ADE_RETRY_DELAY_MS));
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ADE_TIMEOUT_MS);
    const start = Date.now();

    try {
      const res = await fetchADEOnce(url, body, controller.signal);
      const latencyMs = Date.now() - start;
      clearTimeout(timeout);

      if (!res.ok) {
        const errorText = await res.text().catch(() => "Unknown error");
        lastError = new Error(`ADE request failed (${res.status}): ${errorText}`);
        console.warn(`[ADE] Attempt ${attempt + 1} failed (${res.status}): ${errorText}`);
        continue;
      }

      const response = (await res.json()) as ADEResponse;
      return { response, latencyMs };
    } catch (err) {
      clearTimeout(timeout);
      const isTimeout = err instanceof DOMException && err.name === "AbortError";
      const message = isTimeout
        ? `ADE request timed out after ${ADE_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : "Unknown ADE error";
      lastError = new Error(message);
      console.warn(`[ADE] Attempt ${attempt + 1} failed: ${message}`);
    }
  }

  throw lastError ?? new Error("ADE request failed after retries");
}
