import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { corsHeaders, handleCorsOptions } from "../../cors";

/**
 * Public model catalog proxy.
 *
 * Web's build-time sync script reads this endpoint, adapts the shape,
 * and writes the result into the bundled fallback. Keeping the proxy
 * here (rather than having web call ADE directly) preserves the
 * existing trust boundary: web only talks to api.
 *
 * The response body is the unmodified `/api/v1/models` payload from
 * ADE. Shape translation to web's runtime model is the consumer's
 * concern, since other downstream consumers (e.g. server-side cost
 * calc) may want a different projection.
 *
 * Caching is in-process with a 5-minute TTL. On ADE failure with any
 * prior cache hit (even stale) we serve the cached payload so a
 * transient ADE outage cannot break the web build.
 */

const log = logger.child({ module: "models-catalog" });

const ADE_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CatalogPayload {
  models: unknown[];
  count: number;
}

interface CacheEntry {
  payload: CatalogPayload;
  expiresAt: number;
}

let cache: CacheEntry | null = null;
let inflight: Promise<CatalogPayload> | null = null;

function isFresh(entry: CacheEntry | null): entry is CacheEntry {
  return entry !== null && entry.expiresAt > Date.now();
}

function isAvailable(model: unknown): boolean {
  if (typeof model !== "object" || model === null) return false;
  return (model as { available?: boolean }).available !== false;
}

async function fetchCatalogFromAde(): Promise<CatalogPayload> {
  const baseUrl = process.env.ADE_BASE_URL ?? "https://ade-sandy.vercel.app";
  const url = `${baseUrl}/api/v1/models`;

  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(ADE_TIMEOUT_MS),
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`ADE /api/v1/models returned ${res.status}`);
  }

  const body = (await res.json()) as CatalogPayload;
  if (!Array.isArray(body.models)) {
    throw new Error("ADE /api/v1/models returned a malformed body");
  }

  const visible = body.models.filter(isAvailable);
  return { models: visible, count: visible.length };
}

async function refresh(): Promise<CatalogPayload> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const payload = await fetchCatalogFromAde();
      cache = { payload, expiresAt: Date.now() + CACHE_TTL_MS };
      return payload;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function getCatalog(): Promise<CatalogPayload> {
  const initial = cache;
  if (isFresh(initial)) return initial.payload;
  try {
    return await refresh();
  } catch (err) {
    const stale = cache;
    if (stale) {
      log.warn("ADE catalog fetch failed; serving stale cache", undefined, err);
      return stale.payload;
    }
    throw err;
  }
}

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");

  try {
    const payload = await getCatalog();
    return NextResponse.json(payload, {
      headers: {
        ...corsHeaders(origin),
        "Cache-Control": "public, max-age=300, s-maxage=300",
      },
    });
  } catch (err) {
    log.error("Failed to load model catalog", err);
    return NextResponse.json(
      { error: "Failed to load model catalog" },
      { status: 503, headers: corsHeaders(origin) }
    );
  }
}
