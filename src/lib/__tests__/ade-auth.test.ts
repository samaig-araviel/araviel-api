import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  exportSPKI,
  generateKeyPair,
  jwtVerify,
  exportPKCS8,
  importSPKI,
  type CryptoKey,
} from "jose";
import {
  __resetAdeAuthForTests,
  getAdeCallerSecret,
  getAdeToken,
  invalidateAdeToken,
} from "@/lib/ade-auth";

const CALLER_SECRET = "test-caller-secret-0123456789abcdef";
const KID = "test-kid-v1";

let publicKey: CryptoKey;

async function encodePkcs8AsBase64(privateKey: CryptoKey): Promise<string> {
  const pem = await exportPKCS8(privateKey);
  return Buffer.from(pem, "utf-8").toString("base64");
}

beforeAll(async () => {
  const keyPair = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  });
  const privateKeyBase64 = await encodePkcs8AsBase64(keyPair.privateKey);

  // Re-import the public key from its SPKI form so tests can verify the
  // tokens minted against a fresh KeyLike, matching what ADE would do.
  const spkiPem = await exportSPKI(keyPair.publicKey);
  publicKey = await importSPKI(spkiPem, "EdDSA");

  process.env.ADE_JWT_PRIVATE_KEY_CURRENT = privateKeyBase64;
  process.env.ADE_JWT_KID_CURRENT = KID;
  process.env.ADE_CALLER_SECRET_CURRENT = CALLER_SECRET;
});

beforeEach(() => {
  __resetAdeAuthForTests();
});

afterEach(() => {
  __resetAdeAuthForTests();
});

describe("getAdeToken", () => {
  it("mints a token that verifies against the matching public key", async () => {
    const token = await getAdeToken();
    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      issuer: "araviel-api",
      audience: "ade",
      algorithms: ["EdDSA"],
    });
    expect(protectedHeader.kid).toBe(KID);
    expect(protectedHeader.alg).toBe("EdDSA");
    expect(payload.iss).toBe("araviel-api");
    expect(payload.aud).toBe("ade");
    expect(payload.exp).toBeTypeOf("number");
    expect(payload.iat).toBeTypeOf("number");
    expect(payload.jti).toBeTypeOf("string");
  });

  it("sets exp to 6 hours after iat", async () => {
    const token = await getAdeToken();
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: "araviel-api",
      audience: "ade",
    });
    const lifetimeSeconds = (payload.exp as number) - (payload.iat as number);
    expect(lifetimeSeconds).toBe(6 * 60 * 60);
  });

  it("returns the same cached token across concurrent callers", async () => {
    const [a, b, c] = await Promise.all([
      getAdeToken(),
      getAdeToken(),
      getAdeToken(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("single-flights the initial mint under concurrency", async () => {
    // If the single-flight lock is working, concurrent callers from a cold
    // cache must all resolve to the identical token (only one mint ran).
    const tokens = await Promise.all(
      Array.from({ length: 25 }, () => getAdeToken())
    );
    const unique = new Set(tokens);
    expect(unique.size).toBe(1);
  });

  it("mints a fresh token when forceRefresh is true", async () => {
    const first = await getAdeToken();
    // Wait 1s so the iat claim differs and jose produces a different token.
    await new Promise((r) => setTimeout(r, 1100));
    const second = await getAdeToken(true);
    expect(second).not.toBe(first);
  });

  it("mints fresh after invalidateAdeToken", async () => {
    const first = await getAdeToken();
    invalidateAdeToken();
    await new Promise((r) => setTimeout(r, 1100));
    const second = await getAdeToken();
    expect(second).not.toBe(first);
  });
});

describe("getAdeCallerSecret", () => {
  it("returns the caller secret from env", async () => {
    const secret = await getAdeCallerSecret();
    expect(secret).toBe(CALLER_SECRET);
  });
});

describe("configuration errors", () => {
  it("throws when the private key env var is missing", async () => {
    const previous = process.env.ADE_JWT_PRIVATE_KEY_CURRENT;
    delete process.env.ADE_JWT_PRIVATE_KEY_CURRENT;
    __resetAdeAuthForTests();
    try {
      await expect(getAdeToken()).rejects.toThrow(
        /ADE_JWT_PRIVATE_KEY_CURRENT/
      );
    } finally {
      process.env.ADE_JWT_PRIVATE_KEY_CURRENT = previous;
      __resetAdeAuthForTests();
    }
  });

  it("throws when the private key env var is malformed", async () => {
    const previous = process.env.ADE_JWT_PRIVATE_KEY_CURRENT;
    process.env.ADE_JWT_PRIVATE_KEY_CURRENT = "not-base64!!!";
    __resetAdeAuthForTests();
    try {
      await expect(getAdeToken()).rejects.toThrow(/PKCS#8/);
    } finally {
      process.env.ADE_JWT_PRIVATE_KEY_CURRENT = previous;
      __resetAdeAuthForTests();
    }
  });
});
