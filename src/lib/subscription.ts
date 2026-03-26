import { getSupabase } from "./supabase";
import { getTextCreditConfig } from "./stripe";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface Subscription {
  tier: string;
  status: string;
  billingInterval: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  firstMonth: boolean;
}

export interface TextCreditState {
  allowed: boolean;
  reason: "monthly_exhausted" | "window_exhausted" | null;
  monthlyUsed: number;
  monthlyLimit: number;
  windowUsed: number;
  windowLimit: number;
  windowResetAt: string;
}

// ─── Subscription Queries ──────────────────────────────────────────────────

/**
 * Get a user's subscription. Returns null if no row exists (treated as free).
 * Uses service role to bypass RLS (called from chat endpoint + webhooks).
 */
export async function getUserSubscription(
  userId: string
): Promise<Subscription | null> {
  const sb = getSupabase();

  const { data, error } = await sb
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error || !data) return null;

  return {
    tier: data.tier,
    status: data.status,
    billingInterval: data.billing_interval,
    stripeCustomerId: data.stripe_customer_id,
    stripeSubscriptionId: data.stripe_subscription_id,
    currentPeriodStart: data.current_period_start,
    currentPeriodEnd: data.current_period_end,
    cancelAtPeriodEnd: data.cancel_at_period_end ?? false,
    firstMonth: data.first_month ?? false,
  };
}

/**
 * Upsert a subscription row. Used by webhooks (service role).
 */
export async function upsertSubscription(data: {
  userId: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  tier: string;
  billingInterval?: string;
  status: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  firstMonth?: boolean;
}): Promise<void> {
  const sb = getSupabase();

  const row: Record<string, unknown> = {
    user_id: data.userId,
    tier: data.tier,
    status: data.status,
  };

  if (data.stripeCustomerId !== undefined)
    row.stripe_customer_id = data.stripeCustomerId;
  if (data.stripeSubscriptionId !== undefined)
    row.stripe_subscription_id = data.stripeSubscriptionId;
  if (data.billingInterval !== undefined)
    row.billing_interval = data.billingInterval;
  if (data.currentPeriodStart !== undefined)
    row.current_period_start = data.currentPeriodStart;
  if (data.currentPeriodEnd !== undefined)
    row.current_period_end = data.currentPeriodEnd;
  if (data.cancelAtPeriodEnd !== undefined)
    row.cancel_at_period_end = data.cancelAtPeriodEnd;
  if (data.firstMonth !== undefined) row.first_month = data.firstMonth;

  const { error } = await sb.from("subscriptions").upsert(row, {
    onConflict: "user_id",
  });

  if (error) {
    console.error("[subscription] Upsert failed:", error.message);
    throw new Error(`Failed to upsert subscription: ${error.message}`);
  }
}

/**
 * Get the Stripe customer ID for a user, or null.
 */
export async function getStripeCustomerId(
  userId: string
): Promise<string | null> {
  const sb = getSupabase();

  const { data } = await sb
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .single();

  return data?.stripe_customer_id ?? null;
}

// ─── Text Credit Functions (Monthly + 3-Hour Window) ───────────────────────

/**
 * Atomically check + consume 1 text credit via Postgres RPC.
 * Handles monthly cap, 3-hour window cap, and window reset.
 * Returns the credit state including whether the credit was allowed.
 */
export async function checkAndConsumeTextCredit(
  userId: string,
  tier: string,
  firstMonth: boolean
): Promise<TextCreditState> {
  const sb = getSupabase();
  const config = getTextCreditConfig(tier, firstMonth);

  const { data, error } = await sb.rpc("consume_text_credit", {
    p_user_id: userId,
    p_monthly_limit: config.monthly,
    p_window_limit: config.window,
    p_first_month_bonus: config.firstMonthBonus,
  });

  if (error) {
    console.error("[subscription] consume_text_credit RPC failed:", error.message);
    // Graceful fallback: allow the request
    return {
      allowed: true,
      reason: null,
      monthlyUsed: 0,
      monthlyLimit: config.monthly + config.firstMonthBonus,
      windowUsed: 0,
      windowLimit: config.window,
      windowResetAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    };
  }

  return {
    allowed: data.allowed,
    reason: data.reason ?? null,
    monthlyUsed: data.monthly_used,
    monthlyLimit: data.monthly_limit,
    windowUsed: data.window_used,
    windowLimit: data.window_limit,
    windowResetAt: data.window_reset_at,
  };
}

/**
 * Read-only: get current text credit state without consuming.
 * Used by GET /api/subscription to return credit status.
 */
export async function getTextCreditState(
  userId: string,
  tier: string,
  firstMonth: boolean
): Promise<Omit<TextCreditState, "allowed" | "reason">> {
  const sb = getSupabase();
  const config = getTextCreditConfig(tier, firstMonth);

  const { data, error } = await sb.rpc("get_text_credit_state", {
    p_user_id: userId,
    p_monthly_limit: config.monthly,
    p_window_limit: config.window,
    p_first_month_bonus: config.firstMonthBonus,
  });

  if (error) {
    console.error("[subscription] get_text_credit_state RPC failed:", error.message);
    return {
      monthlyUsed: 0,
      monthlyLimit: config.monthly + config.firstMonthBonus,
      windowUsed: 0,
      windowLimit: config.window,
      windowResetAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    };
  }

  return {
    monthlyUsed: data.monthly_used,
    monthlyLimit: data.monthly_limit,
    windowUsed: data.window_used,
    windowLimit: data.window_limit,
    windowResetAt: data.window_reset_at,
  };
}

/**
 * Reset monthly text credits. Called on billing period renewal (webhook).
 */
export async function resetMonthlyTextCredits(userId: string): Promise<void> {
  const sb = getSupabase();

  const { error } = await sb.rpc("reset_monthly_text_credits", {
    p_user_id: userId,
  });

  if (error) {
    console.error("[subscription] resetMonthlyTextCredits failed:", error.message);
  }
}
