import { badRequest } from "./error-response";

/**
 * Age verification configuration resolved from environment variables. The
 * feature is opt-in via `AGE_VERIFICATION_ENABLED=true`; the threshold is
 * tunable via `AGE_VERIFICATION_MIN_AGE` so we can adjust without a code
 * change. Read fresh on every call so tests can flip it per-case.
 */
export interface AgeVerificationConfig {
  enabled: boolean;
  minimumAge: number;
}

const DEFAULT_MINIMUM_AGE = 13;

export function getAgeVerificationConfig(): AgeVerificationConfig {
  const enabled = process.env.AGE_VERIFICATION_ENABLED === "true";
  const raw = process.env.AGE_VERIFICATION_MIN_AGE;
  const parsed = raw === undefined ? NaN : Number(raw);
  const minimumAge =
    Number.isFinite(parsed) && parsed > 0 && parsed < 120
      ? Math.floor(parsed)
      : DEFAULT_MINIMUM_AGE;
  return { enabled, minimumAge };
}

/**
 * Age in completed years. Computed by year diff with a month/day rollback
 * so birthdays that haven't happened yet this year don't tick up early.
 * Avoids the off-by-one drift of `(today - dob) / 365.25`.
 */
export function computeAge(dob: Date, today: Date = new Date()): number {
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = today.getUTCMonth() - dob.getUTCMonth();
  const dayDelta = today.getUTCDate() - dob.getUTCDate();
  if (monthDelta < 0 || (monthDelta === 0 && dayDelta < 0)) {
    age -= 1;
  }
  return age;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PLAUSIBLE_AGE = 120;

/**
 * Parse and validate a `YYYY-MM-DD` string. Throws a 400 ApiError on any
 * shape, parsing, or sanity-check failure — call sites can let the error
 * bubble straight through `respondError`.
 */
export function parseIsoDate(value: unknown): Date {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    throw badRequest(
      "dateOfBirth must be a string in YYYY-MM-DD format",
      "Please enter a valid date of birth.",
    );
  }
  // Construct in UTC to keep the date stable regardless of server timezone.
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw badRequest(
      "dateOfBirth is not a real calendar date",
      "Please enter a valid date of birth.",
    );
  }
  const today = new Date();
  if (date.getTime() > today.getTime()) {
    throw badRequest(
      "dateOfBirth is in the future",
      "Please enter a valid date of birth.",
    );
  }
  if (computeAge(date, today) > MAX_PLAUSIBLE_AGE) {
    throw badRequest(
      "dateOfBirth implies an unrealistic age",
      "Please enter a valid date of birth.",
    );
  }
  return date;
}

export type AgeStatus = "pending" | "blocked" | "verified";

/**
 * Derive the user's verification status from a stored DOB plus the current
 * threshold. Computed live on every call so changes to either input — DOB
 * being recorded, the user's age ticking up over a birthday, or the operator
 * tuning `AGE_VERIFICATION_MIN_AGE` — take effect on the next request without
 * a backfill or migration.
 */
export function deriveStatus(
  dob: Date | null,
  minimumAge: number,
  today: Date = new Date(),
): AgeStatus {
  if (!dob) return "pending";
  return computeAge(dob, today) >= minimumAge ? "verified" : "blocked";
}

/**
 * Format a Date as `YYYY-MM-DD` in UTC for transport in JSON responses.
 */
export function formatIsoDate(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}
