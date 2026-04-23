/**
 * CORS allowlist.
 *
 * The set of allowed browser origins is loaded from the
 * `ALLOWED_ORIGINS` env var (comma-separated). This keeps preview,
 * staging, and custom-domain deployments configurable without code
 * changes. When the var is absent or empty we fall back to the known
 * production and local-development origins so a misconfigured
 * deployment still serves the canonical surfaces instead of mirroring
 * arbitrary origins.
 */

const FALLBACK_ALLOWED_ORIGINS: readonly string[] = [
  "https://araviel.ai",
  "https://araviel-web.vercel.app",
  "http://localhost:5173",
];

const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization, X-User-Id, X-Request-Id";
const MAX_AGE_SECONDS = "86400";

let cachedAllowedOrigins: readonly string[] | null = null;

function parseAllowedOrigins(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function loadAllowedOrigins(): readonly string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return FALLBACK_ALLOWED_ORIGINS;

  const parsed = parseAllowedOrigins(raw);
  return parsed.length > 0 ? parsed : FALLBACK_ALLOWED_ORIGINS;
}

function getAllowedOrigins(): readonly string[] {
  if (!cachedAllowedOrigins) {
    cachedAllowedOrigins = loadAllowedOrigins();
  }
  return cachedAllowedOrigins;
}

function resolveAllowedOrigin(origin?: string | null): string {
  const allowed = getAllowedOrigins();
  if (origin && allowed.includes(origin)) {
    return origin;
  }
  return allowed[0];
}

export function corsHeaders(origin?: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": resolveAllowedOrigin(origin),
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": MAX_AGE_SECONDS,
    "Vary": "Origin",
  };
}

export function handleCorsOptions(origin?: string | null): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

/**
 * Test-only helper. Drops the cached allowlist so tests can mutate
 * `process.env.ALLOWED_ORIGINS` between cases. Never call from
 * production code.
 */
export function __resetCorsAllowlistForTests(): void {
  cachedAllowedOrigins = null;
}
