import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  computeAge,
  deriveStatus,
  formatIsoDate,
  getAgeVerificationConfig,
  parseIsoDate,
} from "@/lib/age";
import { ApiError } from "@/lib/error-response";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe("computeAge", () => {
  it("returns full years on the day before the birthday", () => {
    expect(computeAge(utc(2000, 6, 15), utc(2026, 6, 14))).toBe(25);
  });

  it("ticks up exactly on the birthday", () => {
    expect(computeAge(utc(2000, 6, 15), utc(2026, 6, 15))).toBe(26);
  });

  it("handles cross-month boundaries", () => {
    expect(computeAge(utc(2000, 7, 1), utc(2026, 6, 30))).toBe(25);
    expect(computeAge(utc(2000, 7, 1), utc(2026, 7, 1))).toBe(26);
  });

  it("returns 0 for someone born today", () => {
    const today = utc(2026, 4, 30);
    expect(computeAge(today, today)).toBe(0);
  });

  it("handles Feb 29 birthdays in non-leap years", () => {
    // Born Feb 29, 2000. On Feb 28, 2025, hasn't hit birthday yet.
    expect(computeAge(utc(2000, 2, 29), utc(2025, 2, 28))).toBe(24);
    // March 1, 2025 — birthday has effectively passed.
    expect(computeAge(utc(2000, 2, 29), utc(2025, 3, 1))).toBe(25);
  });
});

describe("deriveStatus", () => {
  const today = utc(2026, 4, 30);

  it("is pending when dob is null", () => {
    expect(deriveStatus(null, 13, today)).toBe("pending");
  });

  it("is blocked one day before turning 13", () => {
    const dob = utc(2013, 5, 1);
    expect(deriveStatus(dob, 13, today)).toBe("blocked");
  });

  it("is verified on the user's 13th birthday", () => {
    const dob = utc(2013, 4, 30);
    expect(deriveStatus(dob, 13, today)).toBe("verified");
  });

  it("is verified for someone well over the threshold", () => {
    expect(deriveStatus(utc(1990, 1, 1), 13, today)).toBe("verified");
  });

  it("respects a custom threshold", () => {
    const dob = utc(2008, 4, 30);
    expect(deriveStatus(dob, 18, today)).toBe("verified");
    expect(deriveStatus(dob, 21, today)).toBe("blocked");
  });
});

describe("parseIsoDate", () => {
  it("parses a valid YYYY-MM-DD string", () => {
    const date = parseIsoDate("1995-08-12");
    expect(date.getUTCFullYear()).toBe(1995);
    expect(date.getUTCMonth()).toBe(7);
    expect(date.getUTCDate()).toBe(12);
  });

  it("rejects non-strings", () => {
    expect(() => parseIsoDate(19950812)).toThrow(ApiError);
    expect(() => parseIsoDate(null)).toThrow(ApiError);
    expect(() => parseIsoDate(undefined)).toThrow(ApiError);
  });

  it("rejects malformed strings", () => {
    expect(() => parseIsoDate("1995/08/12")).toThrow(ApiError);
    expect(() => parseIsoDate("1995-8-12")).toThrow(ApiError);
    expect(() => parseIsoDate("12-08-1995")).toThrow(ApiError);
  });

  it("rejects impossible calendar dates", () => {
    expect(() => parseIsoDate("2025-02-30")).toThrow(ApiError);
    expect(() => parseIsoDate("2025-13-01")).toThrow(ApiError);
    expect(() => parseIsoDate("2025-00-10")).toThrow(ApiError);
  });

  it("rejects future dates", () => {
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 1);
    expect(() => parseIsoDate(formatIsoDate(future))).toThrow(ApiError);
  });

  it("rejects ages over 120", () => {
    expect(() => parseIsoDate("1850-01-01")).toThrow(ApiError);
  });
});

describe("formatIsoDate", () => {
  it("formats UTC dates as YYYY-MM-DD", () => {
    expect(formatIsoDate(utc(2000, 1, 5))).toBe("2000-01-05");
    expect(formatIsoDate(utc(1999, 12, 31))).toBe("1999-12-31");
  });
});

describe("getAgeVerificationConfig", () => {
  const originalEnabled = process.env.AGE_VERIFICATION_ENABLED;
  const originalMinAge = process.env.AGE_VERIFICATION_MIN_AGE;

  beforeEach(() => {
    delete process.env.AGE_VERIFICATION_ENABLED;
    delete process.env.AGE_VERIFICATION_MIN_AGE;
  });

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.AGE_VERIFICATION_ENABLED;
    else process.env.AGE_VERIFICATION_ENABLED = originalEnabled;
    if (originalMinAge === undefined) delete process.env.AGE_VERIFICATION_MIN_AGE;
    else process.env.AGE_VERIFICATION_MIN_AGE = originalMinAge;
  });

  it("defaults to disabled with a minimum age of 13", () => {
    expect(getAgeVerificationConfig()).toEqual({ enabled: false, minimumAge: 13 });
  });

  it("respects AGE_VERIFICATION_ENABLED=true", () => {
    process.env.AGE_VERIFICATION_ENABLED = "true";
    expect(getAgeVerificationConfig().enabled).toBe(true);
  });

  it("treats any non-'true' value as disabled", () => {
    process.env.AGE_VERIFICATION_ENABLED = "1";
    expect(getAgeVerificationConfig().enabled).toBe(false);
    process.env.AGE_VERIFICATION_ENABLED = "TRUE";
    expect(getAgeVerificationConfig().enabled).toBe(false);
  });

  it("reads AGE_VERIFICATION_MIN_AGE", () => {
    process.env.AGE_VERIFICATION_MIN_AGE = "16";
    expect(getAgeVerificationConfig().minimumAge).toBe(16);
  });

  it("falls back to 13 for invalid threshold values", () => {
    process.env.AGE_VERIFICATION_MIN_AGE = "not-a-number";
    expect(getAgeVerificationConfig().minimumAge).toBe(13);
    process.env.AGE_VERIFICATION_MIN_AGE = "0";
    expect(getAgeVerificationConfig().minimumAge).toBe(13);
    process.env.AGE_VERIFICATION_MIN_AGE = "150";
    expect(getAgeVerificationConfig().minimumAge).toBe(13);
  });
});
