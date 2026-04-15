import { NextRequest } from "next/server";
import { logger, Logger } from "./logger";

/**
 * Request context resolved at the top of every route handler.
 *
 * - `requestId` is read from the `X-Request-Id` header when the client
 *   provided one (our frontend does) and generated otherwise. Either way
 *   the same id flows into every log line for that request and is echoed
 *   back to the client in the response, so a user-reported "Ref" code
 *   pastes straight into Vercel log search.
 *
 * - `log` is a child logger pre-bound to `requestId` and `route` so call
 *   sites don't repeat themselves.
 *
 * This is deliberately not an AsyncLocalStorage-based context. Each route
 * handler simply calls `requestContext(request, "route.name")` once and
 * passes the `log` around — explicit is cheaper to reason about at this
 * scale and avoids coupling to an experimental Node feature on Vercel.
 */
export interface RequestContext {
  requestId: string;
  route: string;
  log: Logger;
}

const REQUEST_ID_HEADER = "x-request-id";

/**
 * Generate a short, sortable request id. Format matches the frontend:
 * base36 timestamp + 6 random chars, so both sides agree on shape.
 */
export function generateRequestId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

/**
 * Build a per-request context from the incoming request. Safe to call even
 * for requests that did not originate from our frontend — the header is
 * optional and a fresh id is generated when absent.
 *
 * @param request - The NextRequest arriving at the route handler.
 * @param route - Short route label used in log lines (e.g. "conversations.list").
 */
export function requestContext(
  request: NextRequest,
  route: string
): RequestContext {
  const headerValue = request.headers.get(REQUEST_ID_HEADER);
  const requestId =
    headerValue && headerValue.length > 0 && headerValue.length <= 128
      ? headerValue
      : generateRequestId();
  return {
    requestId,
    route,
    log: logger.child({ requestId, route }),
  };
}

/**
 * Merge `X-Request-Id` into a response headers object so clients can
 * correlate UI toasts with server log entries.
 */
export function withRequestId(
  headers: Record<string, string>,
  requestId: string
): Record<string, string> {
  return { ...headers, "X-Request-Id": requestId };
}

export const REQUEST_ID_HEADER_NAME = "X-Request-Id";
