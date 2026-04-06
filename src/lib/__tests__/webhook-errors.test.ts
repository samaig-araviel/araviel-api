import { describe, it, expect } from "vitest";
import {
  WebhookBadRequestError,
  WebhookRetryableError,
} from "@/lib/webhook-errors";

describe("WebhookBadRequestError", () => {
  it("has status 400", () => {
    const err = new WebhookBadRequestError("Missing metadata");
    expect(err.status).toBe(400);
  });

  it("has name WebhookBadRequestError", () => {
    const err = new WebhookBadRequestError("test");
    expect(err.name).toBe("WebhookBadRequestError");
  });

  it("has the provided message", () => {
    const err = new WebhookBadRequestError("Missing pack type");
    expect(err.message).toBe("Missing pack type");
  });

  it("is an instance of Error", () => {
    const err = new WebhookBadRequestError("test");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("WebhookRetryableError", () => {
  it("has status 500", () => {
    const err = new WebhookRetryableError("DB error");
    expect(err.status).toBe(500);
  });

  it("has name WebhookRetryableError", () => {
    const err = new WebhookRetryableError("test");
    expect(err.name).toBe("WebhookRetryableError");
  });

  it("has the provided message", () => {
    const err = new WebhookRetryableError("Network failure");
    expect(err.message).toBe("Network failure");
  });

  it("is an instance of Error", () => {
    const err = new WebhookRetryableError("test");
    expect(err).toBeInstanceOf(Error);
  });
});
