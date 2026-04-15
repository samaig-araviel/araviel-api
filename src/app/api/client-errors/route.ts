import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, handleCorsOptions } from "../cors";
import { requestContext, withRequestId } from "@/lib/request-context";

/**
 * Receiver for client-side log records. The frontend ships any `warn` or
 * `error` it emits through this endpoint so the full context survives in
 * Vercel logs — browser `console` output is never captured server-side.
 *
 * The endpoint is intentionally minimal: it validates the payload, strips
 * obviously unbounded fields, and forwards the record to the same
 * structured logger used elsewhere, tagging it with `source: "client"`.
 * No database, no auth — the signal is the ability to search "level:error
 * source:client" in Vercel without cost.
 *
 * To prevent abuse, the endpoint:
 *  - caps the payload size (bodies larger than 16 KiB are dropped);
 *  - truncates long `stack`/`message` fields;
 *  - never echoes the payload back to the caller.
 */

const MAX_BODY_BYTES = 16 * 1024;
const MAX_STRING_LENGTH = 4000;

type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

function truncate(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(truncate);
  if (typeof value === "object") return truncateObject(value as Record<string, unknown>);
  return null;
}

function truncateObject(value: Record<string, unknown>): { [key: string]: Json } {
  const out: { [key: string]: Json } = {};
  let count = 0;
  for (const [k, v] of Object.entries(value)) {
    if (count++ >= 30) break;
    out[k] = truncate(v);
  }
  return out;
}

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const ctx = requestContext(request, "client-errors.ingest");

  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) {
    return new NextResponse(null, {
      status: 413,
      headers: withRequestId(corsHeaders(origin), ctx.requestId),
    });
  }

  let payload: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return new NextResponse(null, {
        status: 413,
        headers: withRequestId(corsHeaders(origin), ctx.requestId),
      });
    }
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new NextResponse(null, {
      status: 400,
      headers: withRequestId(corsHeaders(origin), ctx.requestId),
    });
  }

  const level = payload.level === "warn" ? "warn" : "error";
  const message =
    typeof payload.message === "string"
      ? payload.message.slice(0, MAX_STRING_LENGTH)
      : "Client log";

  const context = {
    source: "client" as const,
    userId: typeof payload.userId === "string" ? payload.userId : undefined,
    url: typeof payload.url === "string" ? payload.url : undefined,
    ...truncateObject(payload),
  };

  if (level === "warn") {
    ctx.log.warn(message, context);
  } else {
    ctx.log.error(message, payload.error, context);
  }

  // 204 so sendBeacon is happy and no response body wastes bandwidth.
  return new NextResponse(null, {
    status: 204,
    headers: withRequestId(corsHeaders(origin), ctx.requestId),
  });
}
