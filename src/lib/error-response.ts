import { NextResponse } from "next/server";
import { corsHeaders } from "@/app/api/cors";
import { withRequestId } from "./request-context";
import type { Logger } from "./logger";

/**
 * Standard error body returned to clients.
 *
 * - `error`: a short, user-safe message the frontend can show verbatim in
 *   a toast or inline banner. Never contains stack traces, SQL, or raw
 *   provider output.
 * - `code`: a machine-readable code (e.g. `AUTH_EXPIRED`) used by clients
 *   that need to branch on specific failures.
 * - `requestId`: the per-request id so support can correlate user reports
 *   with Vercel logs.
 * - `userMessage`: optional richer message specific to this failure; takes
 *   precedence over `error` on the client when present.
 */
export interface ApiErrorBody {
  error: string;
  code: string;
  requestId: string;
  userMessage?: string;
}

/**
 * Typed API error. Throw inside a route handler and catch with
 * `respondError` to convert it into a sanitized response.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly userMessage?: string;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    userMessage?: string;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.userMessage = opts.userMessage;
    if (opts.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = opts.cause;
    }
  }
}

// ─── Convenience constructors ──────────────────────────────────────────────
// Each helper maps a failure mode to the canonical HTTP status code the
// frontend expects. Use them instead of hand-rolled `ApiError` instances to
// keep status codes consistent across routes.

export function badRequest(message: string, userMessage?: string): ApiError {
  return new ApiError({
    status: 400,
    code: "VALIDATION_ERROR",
    message,
    userMessage,
  });
}

export function unauthorized(message = "Authentication required"): ApiError {
  return new ApiError({
    status: 401,
    code: "AUTH_EXPIRED",
    message,
    userMessage: "Your session has expired. Please sign in again to continue.",
  });
}

export function forbidden(message = "Forbidden"): ApiError {
  return new ApiError({
    status: 403,
    code: "FORBIDDEN",
    message,
    userMessage: "You don't have permission to do that.",
  });
}

export function notFound(resource: string): ApiError {
  return new ApiError({
    status: 404,
    code: "NOT_FOUND",
    message: `${resource} not found`,
    userMessage: `We couldn't find that ${resource.toLowerCase()}.`,
  });
}

export function conflict(message: string, userMessage?: string): ApiError {
  return new ApiError({
    status: 409,
    code: "CONFLICT",
    message,
    userMessage:
      userMessage ||
      "That change conflicts with a recent update. Please refresh and try again.",
  });
}

export function tooManyRequests(
  message = "Rate limit exceeded",
  userMessage?: string
): ApiError {
  return new ApiError({
    status: 429,
    code: "RATE_LIMITED",
    message,
    userMessage:
      userMessage || "You're doing that a bit too often. Please try again in a moment.",
  });
}

export function quotaExceeded(
  message = "Quota exceeded",
  userMessage?: string
): ApiError {
  return new ApiError({
    status: 402,
    code: "QUOTA_EXCEEDED",
    message,
    userMessage:
      userMessage ||
      "You've reached your current plan's limit. Upgrade to keep going.",
  });
}

export function internalError(
  message = "Internal server error",
  userMessage?: string
): ApiError {
  return new ApiError({
    status: 500,
    code: "INTERNAL_ERROR",
    message,
    userMessage:
      userMessage ||
      "Something went wrong on our end. We're looking into it — please try again.",
  });
}

/**
 * Convert any caught error into a sanitized `NextResponse` suitable for
 * returning from a route handler. Known `ApiError` instances are mapped to
 * their declared status and code; anything else is reported as an
 * internal error with the full details logged server-side only.
 *
 * @param err - The caught error (unknown shape).
 * @param log - Per-request logger used to record the failure.
 * @param options
 * @param options.requestId - Value echoed back to the client as `requestId`.
 * @param options.origin - Origin header value for CORS.
 */
export function respondError(
  err: unknown,
  log: Logger,
  options: { requestId: string; origin?: string | null }
): NextResponse<ApiErrorBody> {
  if (err instanceof ApiError) {
    // Validation-style errors are expected; log at warn so alerts don't fire.
    if (err.status >= 500) {
      log.error(`Route error: ${err.message}`, err);
    } else {
      log.warn("Request rejected", { status: err.status, code: err.code }, err);
    }
    const body: ApiErrorBody = {
      error: err.message,
      code: err.code,
      requestId: options.requestId,
      ...(err.userMessage ? { userMessage: err.userMessage } : {}),
    };
    return NextResponse.json(body, {
      status: err.status,
      headers: withRequestId(corsHeaders(options.origin), options.requestId),
    });
  }

  log.error("Unhandled route error", err);
  const body: ApiErrorBody = {
    error: "Something went wrong on our end. Please try again.",
    code: "INTERNAL_ERROR",
    requestId: options.requestId,
    userMessage:
      "Something went wrong on our end. We're looking into it — please try again.",
  };
  return NextResponse.json(body, {
    status: 500,
    headers: withRequestId(corsHeaders(options.origin), options.requestId),
  });
}

/**
 * Return a successful JSON response with CORS + request id headers applied.
 * Keeps route handlers from hand-rolling the headers each time.
 */
export function respondJson<T>(
  body: T,
  options: {
    requestId: string;
    origin?: string | null;
    status?: number;
    headers?: Record<string, string>;
  }
): NextResponse<T> {
  return NextResponse.json(body, {
    status: options.status ?? 200,
    headers: {
      ...withRequestId(corsHeaders(options.origin), options.requestId),
      ...(options.headers ?? {}),
    },
  });
}
