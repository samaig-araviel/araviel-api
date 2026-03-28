/**
 * Thrown when a webhook event contains permanently invalid data
 * (missing metadata, unknown pack type, etc.).
 * Returns 400 — Stripe will NOT retry.
 */
export class WebhookBadRequestError extends Error {
  public readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "WebhookBadRequestError";
  }
}

/**
 * Thrown when a transient failure prevents processing
 * (DB errors, network issues, Stripe API errors).
 * Returns 500 — Stripe WILL retry with exponential backoff.
 */
export class WebhookRetryableError extends Error {
  public readonly status = 500;

  constructor(message: string) {
    super(message);
    this.name = "WebhookRetryableError";
  }
}
