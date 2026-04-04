import { describe, it, expect, beforeEach } from "vitest";
import {
  getTierFromPriceId,
  getPriceId,
  getPackPriceId,
  getPackFromPriceId,
  getTextCreditConfig,
  getApexUrl,
  TIER_TEXT_CREDITS,
  TIER_IMAGE_CREDITS,
} from "@/lib/stripe";

describe("stripe helpers", () => {
  beforeEach(() => {
    process.env.STRIPE_PRICE_LITE_MONTHLY = "price_lite_mo";
    process.env.STRIPE_PRICE_LITE_ANNUAL = "price_lite_an";
    process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_mo";
    process.env.STRIPE_PRICE_PRO_ANNUAL = "price_pro_an";
    process.env.STRIPE_PRICE_IMAGE_STARTER = "price_img_starter";
    process.env.STRIPE_PRICE_IMAGE_CREATOR = "price_img_creator";
    process.env.STRIPE_PRICE_IMAGE_STUDIO = "price_img_studio";
  });

  describe("getTierFromPriceId", () => {
    it("returns lite monthly for matching price", () => {
      const result = getTierFromPriceId("price_lite_mo");
      expect(result).toEqual({ tier: "lite", interval: "monthly" });
    });

    it("returns lite annual for matching price", () => {
      const result = getTierFromPriceId("price_lite_an");
      expect(result).toEqual({ tier: "lite", interval: "annual" });
    });

    it("returns pro monthly for matching price", () => {
      const result = getTierFromPriceId("price_pro_mo");
      expect(result).toEqual({ tier: "pro", interval: "monthly" });
    });

    it("returns pro annual for matching price", () => {
      const result = getTierFromPriceId("price_pro_an");
      expect(result).toEqual({ tier: "pro", interval: "annual" });
    });

    it("returns null for unknown price id", () => {
      expect(getTierFromPriceId("price_unknown")).toBeNull();
    });
  });

  describe("getPriceId", () => {
    it("returns price for lite monthly", () => {
      expect(getPriceId("lite", "monthly")).toBe("price_lite_mo");
    });

    it("returns price for pro annual", () => {
      expect(getPriceId("pro", "annual")).toBe("price_pro_an");
    });

    it("returns null for unknown tier", () => {
      expect(getPriceId("enterprise", "monthly")).toBeNull();
    });
  });

  describe("getPackPriceId", () => {
    it("returns price for starter pack", () => {
      expect(getPackPriceId("starter")).toBe("price_img_starter");
    });

    it("returns price for creator pack", () => {
      expect(getPackPriceId("creator")).toBe("price_img_creator");
    });

    it("returns price for studio pack", () => {
      expect(getPackPriceId("studio")).toBe("price_img_studio");
    });

    it("returns null for unknown pack", () => {
      expect(getPackPriceId("mega")).toBeNull();
    });
  });

  describe("getPackFromPriceId", () => {
    it("returns starter for matching price", () => {
      expect(getPackFromPriceId("price_img_starter")).toEqual({
        packType: "starter",
      });
    });

    it("returns creator for matching price", () => {
      expect(getPackFromPriceId("price_img_creator")).toEqual({
        packType: "creator",
      });
    });

    it("returns studio for matching price", () => {
      expect(getPackFromPriceId("price_img_studio")).toEqual({
        packType: "studio",
      });
    });

    it("returns null for unknown price", () => {
      expect(getPackFromPriceId("price_unknown")).toBeNull();
    });
  });

  describe("TIER_TEXT_CREDITS", () => {
    it("defines free, lite, and pro tiers", () => {
      expect(TIER_TEXT_CREDITS.free).toBeDefined();
      expect(TIER_TEXT_CREDITS.lite).toBeDefined();
      expect(TIER_TEXT_CREDITS.pro).toBeDefined();
    });

    it("free tier has correct values", () => {
      expect(TIER_TEXT_CREDITS.free).toEqual({
        monthly: 100,
        window: 8,
        firstMonthBonus: 0,
      });
    });

    it("higher tiers have more credits", () => {
      expect(TIER_TEXT_CREDITS.lite.monthly).toBeGreaterThan(
        TIER_TEXT_CREDITS.free.monthly
      );
      expect(TIER_TEXT_CREDITS.pro.monthly).toBeGreaterThan(
        TIER_TEXT_CREDITS.lite.monthly
      );
    });
  });

  describe("TIER_IMAGE_CREDITS", () => {
    it("scales with tier level", () => {
      expect(TIER_IMAGE_CREDITS.free).toBe(5);
      expect(TIER_IMAGE_CREDITS.lite).toBe(50);
      expect(TIER_IMAGE_CREDITS.pro).toBe(150);
    });
  });

  describe("getTextCreditConfig", () => {
    // Note: more detailed tests exist in first-month-bonus.test.ts
    it("returns config without bonus when firstMonth is false", () => {
      const config = getTextCreditConfig("lite", false);
      expect(config.firstMonthBonus).toBe(0);
    });

    it("returns config with bonus when firstMonth is true", () => {
      const config = getTextCreditConfig("pro", true);
      expect(config.firstMonthBonus).toBe(2000);
    });
  });

  describe("getApexUrl", () => {
    it("returns APEX_URL env var when set", () => {
      process.env.APEX_URL = "https://custom.url";
      expect(getApexUrl()).toBe("https://custom.url");
      delete process.env.APEX_URL;
    });

    it("returns production URL when not in development", () => {
      delete process.env.APEX_URL;
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      expect(getApexUrl()).toBe("https://araviel-web.vercel.app");
      process.env.NODE_ENV = origEnv;
    });

    it("returns localhost in development", () => {
      delete process.env.APEX_URL;
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      expect(getApexUrl()).toBe("http://localhost:5173");
      process.env.NODE_ENV = origEnv;
    });
  });
});
