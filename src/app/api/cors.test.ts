import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetCorsAllowlistForTests,
  corsHeaders,
  handleCorsOptions,
} from "./cors";

const ORIGINAL_ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS;

beforeEach(() => {
  delete process.env.ALLOWED_ORIGINS;
  __resetCorsAllowlistForTests();
});

afterEach(() => {
  if (ORIGINAL_ALLOWED_ORIGINS === undefined) {
    delete process.env.ALLOWED_ORIGINS;
  } else {
    process.env.ALLOWED_ORIGINS = ORIGINAL_ALLOWED_ORIGINS;
  }
  __resetCorsAllowlistForTests();
});

describe("corsHeaders", () => {
  it("echoes the request origin when it matches the fallback allowlist", () => {
    expect(corsHeaders("https://araviel-web.vercel.app")["Access-Control-Allow-Origin"]).toBe(
      "https://araviel-web.vercel.app"
    );
    expect(corsHeaders("http://localhost:5173")["Access-Control-Allow-Origin"]).toBe(
      "http://localhost:5173"
    );
    expect(corsHeaders("https://araviel.ai")["Access-Control-Allow-Origin"]).toBe(
      "https://araviel.ai"
    );
  });

  it("merges ALLOWED_ORIGINS with the fallback so canonical surfaces stay allowed", () => {
    process.env.ALLOWED_ORIGINS = "https://custom.example.com";
    __resetCorsAllowlistForTests();

    expect(corsHeaders("https://custom.example.com")["Access-Control-Allow-Origin"]).toBe(
      "https://custom.example.com"
    );
    expect(corsHeaders("https://araviel-web.vercel.app")["Access-Control-Allow-Origin"]).toBe(
      "https://araviel-web.vercel.app"
    );
  });

  it("falls back to the first allowed origin for unknown or missing origins", () => {
    expect(corsHeaders(null)["Access-Control-Allow-Origin"]).toBe("https://araviel.ai");
    expect(corsHeaders(undefined)["Access-Control-Allow-Origin"]).toBe("https://araviel.ai");
    expect(corsHeaders("https://attacker.example")["Access-Control-Allow-Origin"]).toBe(
      "https://araviel.ai"
    );
  });

  it("always sets credentials, methods, headers, max-age, and Vary: Origin", () => {
    const headers = corsHeaders("https://araviel.ai");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
    expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
    expect(headers["Access-Control-Allow-Headers"]).toContain("Authorization");
    expect(headers["Access-Control-Max-Age"]).toBe("86400");
    expect(headers["Vary"]).toBe("Origin");
  });
});

describe("handleCorsOptions", () => {
  it("returns 204 with the echoed origin", async () => {
    const response = handleCorsOptions("https://araviel-web.vercel.app");
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://araviel-web.vercel.app"
    );
  });

  it("does not echo arbitrary origins", async () => {
    const response = handleCorsOptions("https://attacker.example");
    expect(response.headers.get("access-control-allow-origin")).not.toBe(
      "https://attacker.example"
    );
  });
});
