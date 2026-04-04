import { describe, it, expect } from "vitest";
import { AuthError, extractBearerToken } from "@/lib/auth";

// Only test pure functions and types — authenticateRequest and withAuth
// require Supabase and NextRequest which need integration tests.

describe("AuthError", () => {
  it("has default status of 401", () => {
    const err = new AuthError("Unauthorized");
    expect(err.status).toBe(401);
  });

  it("accepts a custom status", () => {
    const err = new AuthError("Server error", 500);
    expect(err.status).toBe(500);
  });

  it("has name AuthError", () => {
    const err = new AuthError("test");
    expect(err.name).toBe("AuthError");
  });

  it("preserves the message", () => {
    const err = new AuthError("Token expired");
    expect(err.message).toBe("Token expired");
  });

  it("is an instance of Error", () => {
    const err = new AuthError("test");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("extractBearerToken", () => {
  // Create a minimal NextRequest-like object for testing
  function makeRequest(authHeader?: string) {
    const headers = new Headers();
    if (authHeader !== undefined) {
      headers.set("authorization", authHeader);
    }
    return { headers: { get: (name: string) => headers.get(name) } } as Parameters<
      typeof extractBearerToken
    >[0];
  }

  it("extracts token from valid Bearer header", () => {
    const req = makeRequest("Bearer my-token-123");
    expect(extractBearerToken(req)).toBe("my-token-123");
  });

  it("returns null when no authorization header", () => {
    const req = makeRequest(undefined);
    expect(extractBearerToken(req)).toBeNull();
  });

  it("returns null when header does not start with Bearer", () => {
    const req = makeRequest("Basic abc123");
    expect(extractBearerToken(req)).toBeNull();
  });

  it("returns null for empty bearer token", () => {
    const req = makeRequest("Bearer ");
    expect(extractBearerToken(req)).toBeNull();
  });

  it("handles token with special characters", () => {
    const req = makeRequest("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig");
    expect(extractBearerToken(req)).toBe(
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"
    );
  });
});
