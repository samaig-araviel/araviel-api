import type { ADEResponse } from "@/lib/types";

interface ADERequestContext {
  conversationId?: string;
  previousModelUsed?: string;
}

interface ADERequest {
  prompt: string;
  modality: string;
  userTier: string;
  context?: ADERequestContext;
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

  if (request.context?.conversationId || request.context?.previousModelUsed) {
    body.context = {
      conversationId: request.context.conversationId,
      previousModelUsed: request.context.previousModelUsed,
    };
  }

  const start = Date.now();

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const errorText = await res.text().catch(() => "Unknown error");
    throw new Error(`ADE request failed (${res.status}): ${errorText}`);
  }

  const response = (await res.json()) as ADEResponse;

  return { response, latencyMs };
}
