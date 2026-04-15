import type { NextRequest } from "next/server";

/**
 * Lightweight in-memory sliding-window rate limiter.
 *
 * Used for public, unauthenticated endpoints where a deterministic per-IP
 * throttle is enough to deter casual scraping. This is intentionally
 * process-local: on serverless runtimes it provides best-effort limiting per
 * warm instance. For stricter limits, upgrade to a shared store (Upstash /
 * Redis) without changing the call sites.
 */

interface RateLimitOptions {
  /** Unique name for the limit bucket (e.g. "shares:get"). */
  key: string;
  /** Maximum number of requests allowed in the window. */
  limit: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Remaining requests in the current window after this call. */
  remaining: number;
  /** Epoch ms at which the current window resets. */
  resetAt: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Extract the best-effort client IP from a Next.js request.
 *
 * Vercel sets `x-forwarded-for` to a comma-separated list with the client IP
 * first. `x-real-ip` is used as a fallback for other proxies.
 */
export function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Consume a token from the per-IP bucket identified by `key`.
 *
 * Uses a fixed window reset: the first request starts a new window of
 * `windowMs`; subsequent requests within that window increment the count
 * until `limit` is reached.
 */
export function rateLimit(
  request: NextRequest,
  { key, limit, windowMs }: RateLimitOptions
): RateLimitResult {
  const ip = getClientIp(request);
  const bucketKey = `${key}:${ip}`;
  const now = Date.now();

  const existing = buckets.get(bucketKey);

  if (!existing || existing.resetAt <= now) {
    const bucket: Bucket = { count: 1, resetAt: now + windowMs };
    buckets.set(bucketKey, bucket);
    return { allowed: true, remaining: limit - 1, resetAt: bucket.resetAt };
  }

  if (existing.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: limit - existing.count,
    resetAt: existing.resetAt,
  };
}

/**
 * Standard rate-limit response headers for HTTP 200 and 429 responses.
 */
export function rateLimitHeaders(
  result: RateLimitResult,
  limit: number
): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
  };
}
