import type { ADEResponse } from "@/lib/types";
import {
  getAdeCallerSecret,
  getAdeToken,
  invalidateAdeToken,
} from "./ade-auth";
import { logger } from "./logger";

const log = logger.child({ module: "ade" });

const ADE_CALLER_AUTH_HEADER = "X-ADE-Caller-Auth";

interface ADERequestContext {
  conversationId?: string;
  previousModelUsed?: string;
}

interface ADEHumanContext {
  emotionalState?: { mood?: string };
  environmentalContext?: { weather?: string };
  preferences?: { tone?: string };
}

interface ADERequest {
  prompt: string;
  modality: string;
  userTier: string;
  availableProviders?: string[];
  context?: ADERequestContext;
  humanContext?: ADEHumanContext;
  tone?: string;
  conversationHasImages?: boolean;
  strategy?: string;
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
  const callerSecret = await getAdeCallerSecret();

  const buildRequest = (token: string) =>
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        [ADE_CALLER_AUTH_HEADER]: callerSecret,
      },
      body: JSON.stringify(body),
      signal,
    });

  const initialToken = await getAdeToken();
  const firstResponse = await buildRequest(initialToken);

  // A 401 from ADE means the token was rejected — most commonly because
  // ADE rotated its verification key while we were holding a cached token
  // signed with the previous one. Drop the cache, mint fresh, retry once.
  if (firstResponse.status !== 401) {
    return firstResponse;
  }

  log.warn("ADE rejected cached token; refreshing and retrying once");
  invalidateAdeToken();
  const freshToken = await getAdeToken(true);
  return buildRequest(freshToken);
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

  if (request.tone) {
    body.tone = request.tone;
  }

  if (request.conversationHasImages) {
    body.conversationHasImages = true;
  }

  if (request.strategy) {
    body.strategy = request.strategy;
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
        log.warn("ADE upstream request failed", {
          attempt: attempt + 1,
          status: res.status,
          error: errorText,
        });
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
      log.warn("ADE call failed", { attempt: attempt + 1, message });
    }
  }

  throw lastError ?? new Error("ADE request failed after retries");
}
