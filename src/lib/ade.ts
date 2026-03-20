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

  const start = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout for ADE

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const errorText = await res.text().catch(() => "Unknown error");
    throw new Error(`ADE request failed (${res.status}): ${errorText}`);
  }

  const response = (await res.json()) as ADEResponse;

  return { response, latencyMs };
}
