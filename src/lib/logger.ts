/**
 * Structured JSON logger for the API.
 *
 * Every log line is a single JSON object written with `process.stdout.write`
 * (or `process.stderr.write` for errors), which is how Vercel captures and
 * indexes logs for search and alerting. Keeping the output strict JSON also
 * makes the logs trivial to ship to any third-party aggregator later.
 *
 * Call sites attach structured fields via `context`; there is no
 * string-concat formatting — the aggregator does the formatting, not us.
 *
 * Usage:
 *   const log = logger.child({ route: "conversations.list", requestId });
 *   log.info("Fetched conversations", { count });
 *   log.error("Fetch failed", err);
 *
 * The module-level `logger` is a convenience for code paths that don't have
 * a request context yet (startup, background jobs).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  [key: string]: unknown;
  requestId?: string;
  userId?: string;
  route?: string;
}

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  status?: number;
  cause?: unknown;
}

const IS_TEST = process.env.NODE_ENV === "test";
const LOG_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(level: LogLevel): boolean {
  if (IS_TEST && level !== "error") return false;
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[LOG_LEVEL];
}

function serializeError(err: unknown): SerializedError | undefined {
  if (!err) return undefined;
  if (err instanceof Error) {
    const errWithExtras = err as Error & {
      code?: string;
      status?: number;
      cause?: unknown;
    };
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: errWithExtras.code,
      status: errWithExtras.status,
      cause: errWithExtras.cause,
    };
  }
  return {
    name: "UnknownError",
    message: typeof err === "string" ? err : JSON.stringify(err),
  };
}

function emit(
  level: LogLevel,
  message: string,
  context: LogContext | undefined,
  err?: unknown
): void {
  if (!shouldLog(level)) return;
  const record = {
    timestamp: new Date().toISOString(),
    level,
    msg: message,
    ...(context ?? {}),
    ...(err !== undefined ? { error: serializeError(err) } : {}),
  };
  const line = `${JSON.stringify(record)}\n`;
  if (level === "error" || level === "warn") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext, err?: unknown): void;
  error(message: string, err?: unknown, context?: LogContext): void;
  child(bindings: LogContext): Logger;
}

function buildLogger(bindings: LogContext = {}): Logger {
  return {
    debug(message, context) {
      emit("debug", message, { ...bindings, ...context });
    },
    info(message, context) {
      emit("info", message, { ...bindings, ...context });
    },
    warn(message, context, err) {
      emit("warn", message, { ...bindings, ...context }, err);
    },
    error(message, err, context) {
      emit("error", message, { ...bindings, ...context }, err);
    },
    child(newBindings) {
      return buildLogger({ ...bindings, ...newBindings });
    },
  };
}

/**
 * Module-level logger. Prefer `logger.child({ requestId, route })` so every
 * line from a request is correlated.
 */
export const logger: Logger = buildLogger();
