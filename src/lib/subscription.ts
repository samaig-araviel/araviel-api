import { getSupabase } from "./supabase";
import { getDailyCreditsLimit } from "./stripe";

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

export interface DailyCredits {
  creditsUsed: number;
  creditsLimit: number;
  bonusCredits: number;
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

// ─── Daily Credit Queries ──────────────────────────────────────────────────

/**
 * Get or create today's daily credit row for a user.
 * If no row exists for today, inserts one with the correct limit.
 */
export async function getOrCreateDailyCredits(
  userId: string,
  tier: string,
  firstMonth: boolean
): Promise<DailyCredits> {
  const sb = getSupabase();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Try to read existing row
  const { data: existing } = await sb
    .from("daily_credits")
    .select("credits_used, credits_limit, bonus_credits")
    .eq("user_id", userId)
    .eq("date", today)
    .single();

  if (existing) {
    return {
      creditsUsed: existing.credits_used,
      creditsLimit: existing.credits_limit,
      bonusCredits: existing.bonus_credits,
    };
  }

  // Create row for today
  const limit = getDailyCreditsLimit(tier, firstMonth);

  const { data: created, error } = await sb
    .from("daily_credits")
    .insert({
      user_id: userId,
      date: today,
      credits_used: 0,
      credits_limit: limit,
      bonus_credits: 0,
    })
    .select("credits_used, credits_limit, bonus_credits")
    .single();

  if (error) {
    // Race condition: another request already created the row
    if (error.code === "23505") {
      const { data: retry } = await sb
        .from("daily_credits")
        .select("credits_used, credits_limit, bonus_credits")
        .eq("user_id", userId)
        .eq("date", today)
        .single();

      if (retry) {
        return {
          creditsUsed: retry.credits_used,
          creditsLimit: retry.credits_limit,
          bonusCredits: retry.bonus_credits,
        };
      }
    }

    console.error("[subscription] Failed to create daily credits:", error.message);
    // Graceful fallback: allow the request with default limits
    return { creditsUsed: 0, creditsLimit: getDailyCreditsLimit(tier, firstMonth), bonusCredits: 0 };
  }

  return {
    creditsUsed: created?.credits_used ?? 0,
    creditsLimit: created?.credits_limit ?? limit,
    bonusCredits: created?.bonus_credits ?? 0,
  };
}

/**
 * Consume credits (atomic increment via Postgres RPC). Fire-and-forget safe.
 */
export async function consumeCredits(
  userId: string,
  amount: number
): Promise<void> {
  const sb = getSupabase();
  const today = new Date().toISOString().slice(0, 10);

  const { error } = await sb.rpc("increment_daily_credits", {
    p_user_id: userId,
    p_date: today,
    p_amount: amount,
  });

  if (error) {
    console.error("[subscription] consumeCredits RPC failed:", error.message);
  }
}
