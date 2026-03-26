import Stripe from "stripe";

// ─── Singleton Stripe Client ───────────────────────────────────────────────

let stripeClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (stripeClient) return stripeClient;

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY environment variable");

  stripeClient = new Stripe(key, { apiVersion: "2026-02-25.clover" });
  return stripeClient;
}

// ─── Price ID → Tier Mapping ───────────────────────────────────────────────

interface TierInfo {
  tier: "lite" | "pro";
  interval: "monthly" | "annual";
}

// Sandbox defaults — env vars override these in production
const SANDBOX_PRICES: Record<string, string> = {
  STRIPE_PRICE_LITE_MONTHLY: "price_1TEzOPDgaoOWbIEAfsQzAeWf",
  STRIPE_PRICE_LITE_ANNUAL: "price_1TEzTRDgaoOWbIEAfIWS9nrC",
  STRIPE_PRICE_PRO_MONTHLY: "price_1TEzRjDgaoOWbIEAxD2w2t0z",
  STRIPE_PRICE_PRO_ANNUAL: "price_1TEzUfDgaoOWbIEAOoeLS3HW",
};

function getPrice(envKey: string): string | undefined {
  return process.env[envKey] || SANDBOX_PRICES[envKey];
}

function buildPriceMap(): Record<string, TierInfo> {
  const map: Record<string, TierInfo> = {};

  const liteMo = getPrice("STRIPE_PRICE_LITE_MONTHLY");
  const liteAn = getPrice("STRIPE_PRICE_LITE_ANNUAL");
  const proMo = getPrice("STRIPE_PRICE_PRO_MONTHLY");
  const proAn = getPrice("STRIPE_PRICE_PRO_ANNUAL");

  if (liteMo) map[liteMo] = { tier: "lite", interval: "monthly" };
  if (liteAn) map[liteAn] = { tier: "lite", interval: "annual" };
  if (proMo) map[proMo] = { tier: "pro", interval: "monthly" };
  if (proAn) map[proAn] = { tier: "pro", interval: "annual" };

  return map;
}

/**
 * Look up tier and interval for a Stripe price ID.
 */
export function getTierFromPriceId(priceId: string): TierInfo | null {
  return buildPriceMap()[priceId] ?? null;
}

/**
 * Get the Stripe price ID for a tier + interval combination.
 */
export function getPriceId(
  tier: string,
  interval: string
): string | null {
  const envKey = `STRIPE_PRICE_${tier.toUpperCase()}_${interval.toUpperCase()}`;
  return getPrice(envKey) ?? null;
}

// ─── Text Credit Limits (Monthly + 3-hour Window) ──────────────────────────

export interface TextCreditConfig {
  monthly: number;
  window: number;
  firstMonthBonus: number;
}

export const TIER_TEXT_CREDITS: Record<string, TextCreditConfig> = {
  free: { monthly: 100, window: 8, firstMonthBonus: 0 },
  lite: { monthly: 1500, window: 60, firstMonthBonus: 750 },
  pro: { monthly: 4000, window: 160, firstMonthBonus: 2000 },
};

export const TIER_IMAGE_CREDITS: Record<string, number> = {
  free: 5,
  lite: 50,
  pro: 150,
};

/**
 * Get text credit config for a tier, including first-month bonus if applicable.
 */
export function getTextCreditConfig(
  tier: string,
  firstMonth: boolean
): TextCreditConfig {
  const config = TIER_TEXT_CREDITS[tier] ?? TIER_TEXT_CREDITS.free;
  return {
    monthly: config.monthly,
    window: config.window,
    firstMonthBonus: firstMonth ? config.firstMonthBonus : 0,
  };
}

// ─── Frontend URL ──────────────────────────────────────────────────────────

export function getApexUrl(): string {
  return (
    process.env.APEX_URL ??
    (process.env.NODE_ENV === "development"
      ? "http://localhost:5173"
      : "https://araviel-web.vercel.app")
  );
}
