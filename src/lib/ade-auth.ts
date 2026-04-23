import { SignJWT, importPKCS8, type CryptoKey } from "jose";
import { logger } from "./logger";

/**
 * Service-to-service auth for calls from araviel-api to ADE.
 *
 * araviel-api holds the Ed25519 private key; ADE holds only the matching
 * public key. The token identifies the service (not individual users) and
 * lives for 6 hours. One cached token is reused across every ADE call,
 * refreshed proactively 5 minutes before expiry. On a 401 from ADE the
 * cache is invalidated and the current request is retried once with a
 * fresh token (handled by the caller, see `ade.ts`).
 *
 * Every function in this module is safe to call concurrently: the
 * underlying mint is single-flighted so a burst of cold-start requests
 * triggers exactly one signing operation.
 */

/**
 * Header that carries the Layer 0 shared secret on every outbound
 * ADE request. Re-exported so callers do not duplicate the literal.
 */
export const ADE_CALLER_AUTH_HEADER = "X-ADE-Caller-Auth";

const ADE_TOKEN_ISSUER = "araviel-api";
const ADE_TOKEN_AUDIENCE = "ade";
const ADE_TOKEN_TTL_SECONDS = 6 * 60 * 60;
const ADE_TOKEN_REFRESH_LEEWAY_SECONDS = 5 * 60;
const ADE_TOKEN_MINT_MAX_ATTEMPTS = 3;
const ADE_TOKEN_MINT_BACKOFF_BASE_MS = 500;

const log = logger.child({ module: "ade-auth" });

class AdeAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdeAuthConfigError";
  }
}

interface AdeAuthConfig {
  privateKey: CryptoKey;
  kid: string;
  callerSecret: string;
}

interface CachedToken {
  token: string;
  /** Unix seconds when the token expires. */
  expiresAt: number;
}

let configPromise: Promise<AdeAuthConfig> | null = null;
let cachedToken: CachedToken | null = null;
let inflightMint: Promise<CachedToken> | null = null;

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new AdeAuthConfigError(
      `Missing required env var for ADE auth: ${name}`
    );
  }
  return value;
}

function decodeBase64ToUtf8(encoded: string): string {
  return Buffer.from(encoded, "base64").toString("utf-8");
}

async function loadAdeAuthConfig(): Promise<AdeAuthConfig> {
  const privateKeyBase64 = readRequiredEnv("ADE_JWT_PRIVATE_KEY_CURRENT");
  const kid = readRequiredEnv("ADE_JWT_KID_CURRENT");
  const callerSecret = readRequiredEnv("ADE_CALLER_SECRET_CURRENT");

  let privateKey: CryptoKey;
  try {
    const pem = decodeBase64ToUtf8(privateKeyBase64);
    privateKey = await importPKCS8(pem, "EdDSA");
  } catch {
    throw new AdeAuthConfigError(
      "ADE_JWT_PRIVATE_KEY_CURRENT is not a valid base64-encoded Ed25519 PKCS#8 PEM"
    );
  }

  return { privateKey, kid, callerSecret };
}

function getAdeAuthConfig(): Promise<AdeAuthConfig> {
  if (!configPromise) {
    configPromise = loadAdeAuthConfig().catch((err) => {
      // Reset so a subsequent call can retry after env is fixed.
      configPromise = null;
      throw err;
    });
  }
  return configPromise;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mintOnce(): Promise<CachedToken> {
  const config = await getAdeAuthConfig();
  const iat = unixNow();
  const exp = iat + ADE_TOKEN_TTL_SECONDS;

  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: config.kid, typ: "JWT" })
    .setIssuer(ADE_TOKEN_ISSUER)
    .setAudience(ADE_TOKEN_AUDIENCE)
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(exp)
    .setJti(crypto.randomUUID())
    .sign(config.privateKey);

  return { token, expiresAt: exp };
}

async function mintWithRetry(): Promise<CachedToken> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ADE_TOKEN_MINT_MAX_ATTEMPTS; attempt++) {
    try {
      return await mintOnce();
    } catch (err) {
      lastError = err;
      log.warn("ADE token mint attempt failed", {
        attempt,
        maxAttempts: ADE_TOKEN_MINT_MAX_ATTEMPTS,
      }, err);
      if (attempt < ADE_TOKEN_MINT_MAX_ATTEMPTS) {
        const backoff = ADE_TOKEN_MINT_BACKOFF_BASE_MS * 2 ** (attempt - 1);
        await sleep(backoff);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("ADE token mint failed after retries");
}

function isTokenFresh(
  token: CachedToken | null,
  leewaySeconds: number
): token is CachedToken {
  if (!token) return false;
  return token.expiresAt - unixNow() > leewaySeconds;
}

async function refreshSingleFlight(): Promise<CachedToken> {
  if (inflightMint) return inflightMint;
  const mintPromise = (async () => {
    try {
      const minted = await mintWithRetry();
      cachedToken = minted;
      return minted;
    } finally {
      inflightMint = null;
    }
  })();
  inflightMint = mintPromise;
  return mintPromise;
}

/**
 * Return a valid ADE service token. Reuses the cached token until it
 * enters the refresh window (5 min before expiry), then mints a new one.
 * Concurrent callers during a refresh share a single mint.
 *
 * @param forceRefresh - Bypass the cache and mint a fresh token. Used by
 *   the caller after receiving a 401 from ADE (e.g. due to key rotation).
 */
export async function getAdeToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && isTokenFresh(cachedToken, ADE_TOKEN_REFRESH_LEEWAY_SECONDS)) {
    return cachedToken.token;
  }
  const minted = await refreshSingleFlight();
  return minted.token;
}

/**
 * Return the Layer 0 shared-secret header value. Sent with every ADE
 * request before the JWT is parsed, so internet noise is dropped
 * without running any crypto.
 */
export async function getAdeCallerSecret(): Promise<string> {
  const config = await getAdeAuthConfig();
  return config.callerSecret;
}

/**
 * Build the full set of headers required to authenticate an outbound
 * ADE call: the service JWT and the Layer 0 caller secret. Mints a
 * fresh token on cold start, otherwise reuses the cached one.
 */
export async function buildAdeAuthHeaders(): Promise<Record<string, string>> {
  const [token, callerSecret] = await Promise.all([
    getAdeToken(),
    getAdeCallerSecret(),
  ]);
  return {
    Authorization: `Bearer ${token}`,
    [ADE_CALLER_AUTH_HEADER]: callerSecret,
  };
}

/**
 * Drop the cached token so the next `getAdeToken()` call mints fresh.
 * Call this after receiving a 401 from ADE.
 */
export function invalidateAdeToken(): void {
  cachedToken = null;
}

/**
 * Test-only helper. Resets all module state so tests can exercise
 * cache/refresh behaviour in isolation. Never call from production code.
 */
export function __resetAdeAuthForTests(): void {
  configPromise = null;
  cachedToken = null;
  inflightMint = null;
}
