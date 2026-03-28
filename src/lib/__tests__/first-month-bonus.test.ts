import { describe, it, expect } from "vitest";
import { getTextCreditConfig } from "@/lib/stripe";
import { resolveFirstMonth } from "@/lib/subscription";

// ─── getTextCreditConfig ──────────────────────────────────────────────────────

describe("getTextCreditConfig", () => {
  it("returns zero bonus for free tier even when firstMonth is true", () => {
    const config = getTextCreditConfig("free", true);
    expect(config).toEqual({ monthly: 100, window: 8, firstMonthBonus: 0 });
  });

  it("returns bonus for lite tier when firstMonth is true", () => {
    const config = getTextCreditConfig("lite", true);
    expect(config).toEqual({ monthly: 1500, window: 60, firstMonthBonus: 750 });
  });

  it("returns bonus for pro tier when firstMonth is true", () => {
    const config = getTextCreditConfig("pro", true);
    expect(config).toEqual({
      monthly: 4000,
      window: 160,
      firstMonthBonus: 2000,
    });
  });

  it("zeroes bonus for lite tier when firstMonth is false", () => {
    const config = getTextCreditConfig("lite", false);
    expect(config).toEqual({ monthly: 1500, window: 60, firstMonthBonus: 0 });
  });

  it("zeroes bonus for pro tier when firstMonth is false", () => {
    const config = getTextCreditConfig("pro", false);
    expect(config).toEqual({ monthly: 4000, window: 160, firstMonthBonus: 0 });
  });

  it("falls back to free config for unknown tier", () => {
    const config = getTextCreditConfig("enterprise", true);
    expect(config).toEqual({ monthly: 100, window: 8, firstMonthBonus: 0 });
  });
});

// ─── resolveFirstMonth ───────────────────────────────────────────────────────

describe("resolveFirstMonth", () => {
  describe("checkout events", () => {
    it("grants firstMonth for a new subscriber (no existing row)", () => {
      const result = resolveFirstMonth({
        isCheckout: true,
        existing: null,
        newPeriodStart: "2026-03-01T00:00:00.000Z",
      });
      expect(result).toBe(true);
    });

    it("re-grants firstMonth for a re-subscriber (was false)", () => {
      const result = resolveFirstMonth({
        isCheckout: true,
        existing: {
          firstMonth: false,
          currentPeriodStart: "2026-01-01T00:00:00.000Z",
        },
        newPeriodStart: "2026-03-01T00:00:00.000Z",
      });
      expect(result).toBe(true);
    });
  });

  describe("renewal detection", () => {
    it("flips firstMonth to false when period start changes (renewal)", () => {
      const result = resolveFirstMonth({
        isCheckout: false,
        existing: {
          firstMonth: true,
          currentPeriodStart: "2026-01-01T00:00:00.000Z",
        },
        newPeriodStart: "2026-02-01T00:00:00.000Z",
      });
      expect(result).toBe(false);
    });
  });

  describe("plan upgrade mid-month", () => {
    it("preserves firstMonth when period start is unchanged", () => {
      const result = resolveFirstMonth({
        isCheckout: false,
        existing: {
          firstMonth: true,
          currentPeriodStart: "2026-03-01T00:00:00.000Z",
        },
        newPeriodStart: "2026-03-01T00:00:00.000Z",
      });
      expect(result).toBe(true);
    });

    it("flips firstMonth to false when Stripe changes period start on upgrade", () => {
      const result = resolveFirstMonth({
        isCheckout: false,
        existing: {
          firstMonth: true,
          currentPeriodStart: "2026-03-01T00:00:00.000Z",
        },
        newPeriodStart: "2026-03-15T00:00:00.000Z",
      });
      expect(result).toBe(false);
    });
  });

  describe("plan downgrade", () => {
    it("keeps firstMonth false when already false", () => {
      const result = resolveFirstMonth({
        isCheckout: false,
        existing: {
          firstMonth: false,
          currentPeriodStart: "2026-03-01T00:00:00.000Z",
        },
        newPeriodStart: "2026-03-15T00:00:00.000Z",
      });
      expect(result).toBe(false);
    });
  });

  describe("guard: non-checkout cannot re-grant", () => {
    it("prevents re-granting when firstMonth is already false", () => {
      const result = resolveFirstMonth({
        isCheckout: false,
        existing: {
          firstMonth: false,
          currentPeriodStart: "2026-02-01T00:00:00.000Z",
        },
        newPeriodStart: "2026-02-01T00:00:00.000Z",
      });
      expect(result).toBe(false);
    });

    it("returns false when no existing subscription and not a checkout", () => {
      const result = resolveFirstMonth({
        isCheckout: false,
        existing: null,
        newPeriodStart: "2026-03-01T00:00:00.000Z",
      });
      expect(result).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles null newPeriodStart with existing firstMonth true", () => {
      const result = resolveFirstMonth({
        isCheckout: false,
        existing: {
          firstMonth: true,
          currentPeriodStart: "2026-03-01T00:00:00.000Z",
        },
        newPeriodStart: null,
      });
      expect(result).toBe(true);
    });

    it("handles null currentPeriodStart with firstMonth true", () => {
      const result = resolveFirstMonth({
        isCheckout: false,
        existing: {
          firstMonth: true,
          currentPeriodStart: null,
        },
        newPeriodStart: "2026-03-01T00:00:00.000Z",
      });
      expect(result).toBe(true);
    });
  });
});
