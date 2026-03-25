import { NextRequest, NextResponse } from "next/server";
import { getStripe, getTierFromPriceId, getDailyCreditsLimit } from "@/lib/stripe";
import { upsertSubscription, getOrCreateDailyCredits } from "@/lib/subscription";
import { updateTier } from "@/lib/credits";
import type Stripe from "stripe";

export const runtime = "nodejs";

/**
 * Stripe webhook handler. No auth middleware — uses Stripe signature verification.
 * Always returns 200 to prevent Stripe retry floods.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("[stripe/webhook] Missing STRIPE_WEBHOOK_SECRET");
    return NextResponse.json({ received: true }, { status: 200 });
  }

  // Read raw body for signature verification
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    console.error("[stripe/webhook] Missing stripe-signature header");
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error(
      "[stripe/webhook] Signature verification failed:",
      err instanceof Error ? err.message : err
    );
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case "invoice.payment_failed":
        await handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;
      default:
        // Unhandled event type — ignore silently
        break;
    }
  } catch (err) {
    // Log but still return 200 to prevent Stripe retries
    console.error(
      `[stripe/webhook] Error processing ${event.type}:`,
      err instanceof Error ? err.message : err
    );
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

// ─── Event Handlers ────────────────────────────────────────────────────────

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session
): Promise<void> {
  const userId = session.metadata?.userId;
  if (!userId) {
    console.error("[stripe/webhook] checkout.session.completed missing userId in metadata");
    return;
  }

  // Get the subscription to find the price ID
  const stripe = getStripe();
  const subscriptionId = session.subscription as string;
  if (!subscriptionId) return;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const subItem = subscription.items.data[0];
  const priceId = subItem?.price?.id;
  if (!priceId) return;

  const tierInfo = getTierFromPriceId(priceId);
  if (!tierInfo) {
    console.error("[stripe/webhook] Unknown price ID:", priceId);
    return;
  }

  // Period info is on subscription items
  const periodStart = subItem.current_period_start;
  const periodEnd = subItem.current_period_end;

  // Upsert subscription with first_month = true
  await upsertSubscription({
    userId,
    stripeCustomerId: session.customer as string,
    stripeSubscriptionId: subscriptionId,
    tier: tierInfo.tier,
    billingInterval: tierInfo.interval,
    status: "active",
    currentPeriodStart: new Date(periodStart * 1000).toISOString(),
    currentPeriodEnd: new Date(periodEnd * 1000).toISOString(),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    firstMonth: true,
  });

  // Create today's daily credits with first-month doubled limit
  const limit = getDailyCreditsLimit(tierInfo.tier, true);
  await getOrCreateDailyCredits(userId, tierInfo.tier, true);

  // Sync image credit tier via existing credits system
  try {
    await updateTier(userId, tierInfo.tier);
  } catch (err) {
    console.error("[stripe/webhook] Failed to sync image credit tier:", err instanceof Error ? err.message : err);
  }

  console.log(
    `[stripe/webhook] Checkout completed: user=${userId} tier=${tierInfo.tier} interval=${tierInfo.interval} credits=${limit}/day`
  );
}

async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription
): Promise<void> {
  const userId = subscription.metadata?.userId;
  if (!userId) {
    console.error("[stripe/webhook] subscription.updated missing userId in metadata");
    return;
  }

  const subItem = subscription.items.data[0];
  const priceId = subItem?.price?.id;
  if (!priceId) return;

  const tierInfo = getTierFromPriceId(priceId);
  if (!tierInfo) {
    console.error("[stripe/webhook] Unknown price ID in subscription.updated:", priceId);
    return;
  }

  const periodStart = subItem.current_period_start;
  const periodEnd = subItem.current_period_end;

  // Map Stripe status
  let status: string;
  switch (subscription.status) {
    case "active":
    case "trialing":
      status = subscription.status;
      break;
    case "past_due":
      status = "past_due";
      break;
    case "canceled":
      status = "cancelled";
      break;
    case "paused":
      status = "paused";
      break;
    default:
      status = "active";
  }

  // Check if this is a renewal (period changed) to flip first_month off
  const { getUserSubscription } = await import("@/lib/subscription");
  const existing = await getUserSubscription(userId);
  const newPeriodStart = new Date(periodStart * 1000).toISOString();
  const isRenewal =
    existing?.firstMonth === true &&
    existing?.currentPeriodStart !== null &&
    newPeriodStart !== existing.currentPeriodStart;

  await upsertSubscription({
    userId,
    stripeCustomerId: subscription.customer as string,
    stripeSubscriptionId: subscription.id,
    tier: tierInfo.tier,
    billingInterval: tierInfo.interval,
    status,
    currentPeriodStart: newPeriodStart,
    currentPeriodEnd: new Date(periodEnd * 1000).toISOString(),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    firstMonth: isRenewal ? false : existing?.firstMonth ?? false,
  });

  // Sync image credit tier
  try {
    await updateTier(userId, tierInfo.tier);
  } catch (err) {
    console.error("[stripe/webhook] Failed to sync image credit tier:", err instanceof Error ? err.message : err);
  }

  console.log(
    `[stripe/webhook] Subscription updated: user=${userId} tier=${tierInfo.tier} status=${status} renewal=${isRenewal}`
  );
}

async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription
): Promise<void> {
  const userId = subscription.metadata?.userId;
  if (!userId) {
    console.error("[stripe/webhook] subscription.deleted missing userId in metadata");
    return;
  }

  await upsertSubscription({
    userId,
    tier: "free",
    status: "cancelled",
    cancelAtPeriodEnd: false,
    firstMonth: false,
  });

  // Revert image credits to free tier
  try {
    await updateTier(userId, "free");
  } catch (err) {
    console.error("[stripe/webhook] Failed to revert image credit tier:", err instanceof Error ? err.message : err);
  }

  console.log(`[stripe/webhook] Subscription deleted: user=${userId} → free tier`);
}

async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const customerId = invoice.customer as string;
  if (!customerId) return;

  // Look up user by stripe_customer_id
  const { getSupabase } = await import("@/lib/supabase");
  const sb = getSupabase();

  const { data } = await sb
    .from("subscriptions")
    .select("user_id, tier")
    .eq("stripe_customer_id", customerId)
    .single();

  if (!data) {
    console.error("[stripe/webhook] payment_failed: no user found for customer", customerId);
    return;
  }

  await upsertSubscription({
    userId: data.user_id,
    tier: data.tier,
    status: "past_due",
  });

  console.log(`[stripe/webhook] Payment failed: user=${data.user_id} → past_due`);
}
