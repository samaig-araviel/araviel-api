import { NextRequest, NextResponse } from "next/server";
import { getStripe, getTierFromPriceId } from "@/lib/stripe";
import { upsertSubscription, resetMonthlyTextCredits } from "@/lib/subscription";
import { updateTier, addPack, PACK_DEFINITIONS } from "@/lib/credits";
import { getSupabase } from "@/lib/supabase";
import { WebhookBadRequestError, WebhookRetryableError } from "@/lib/webhook-errors";
import type Stripe from "stripe";

export const runtime = "nodejs";

/**
 * Stripe webhook handler. No auth middleware — uses Stripe signature verification.
 *
 * Return codes:
 *   200 — event processed successfully, or duplicate (already processed)
 *   400 — malformed/invalid event (Stripe will NOT retry)
 *   500 — transient failure (Stripe WILL retry with backoff)
 */
export async function POST(request: NextRequest): Promise<Response> {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("[stripe/webhook] Missing STRIPE_WEBHOOK_SECRET");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
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
    console.log("[stripe/webhook] Signature verified | Event:", event.type, "| ID:", event.id);
  } catch (err) {
    console.error(
      "[stripe/webhook] Signature verification failed:",
      err instanceof Error ? err.message : err
    );
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // ── Idempotency check ──────────────────────────────────────────────────
  let isDuplicate: boolean;
  try {
    isDuplicate = await checkAndRecordEvent(event.id, event.type);
  } catch (err) {
    console.error("[stripe/webhook] Idempotency check failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  if (isDuplicate) {
    return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
  }

  // ── Process the event ──────────────────────────────────────────────────
  try {
    console.log("[stripe/webhook] Processing event:", event.type);

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
        // Unhandled event type — acknowledge without processing
        break;
    }

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    console.error(`[stripe/webhook] Error processing ${event.type}:`, {
      eventId: event.id,
      error: errorMessage,
      stack: errorStack,
    });

    if (err instanceof WebhookBadRequestError) {
      // Permanent failure — keep the event record to prevent re-processing
      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    // Transient failure — remove the event record so Stripe's retry can re-process
    await rollbackEventRecord(event.id);

    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}

// ─── Idempotency Helpers ──────────────────────────────────────────────────────

/**
 * Atomically record a Stripe event ID. Returns true if the event was
 * already processed (duplicate). Uses the PRIMARY KEY constraint on
 * stripe_events.id — concurrent inserts for the same ID will have
 * exactly one succeed and the rest fail with code 23505.
 */
async function checkAndRecordEvent(eventId: string, eventType: string): Promise<boolean> {
  const sb = getSupabase();
  const { error } = await sb
    .from("stripe_events")
    .insert({ id: eventId, event_type: eventType });

  if (error) {
    // Postgres unique violation = already processed
    if (error.code === "23505") {
      console.log(`[stripe/webhook] Duplicate event ${eventId}, skipping`);
      return true;
    }
    // Any other DB error is transient
    throw new WebhookRetryableError(`Failed to record event: ${error.message}`);
  }

  return false;
}

/**
 * Remove a stripe_events record so the event can be retried.
 * Called when processing fails with a transient error.
 */
async function rollbackEventRecord(eventId: string): Promise<void> {
  try {
    const sb = getSupabase();
    await sb.from("stripe_events").delete().eq("id", eventId);
  } catch (deleteErr) {
    console.error(
      "[stripe/webhook] Failed to rollback event record:",
      deleteErr instanceof Error ? deleteErr.message : deleteErr
    );
  }
}

// ─── Event Handlers ───────────────────────────────────────────────────────────

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session
): Promise<void> {
  console.log("[stripe/webhook] checkout.session.completed | mode:", session.mode);

  const userId = session.metadata?.userId;
  if (!userId) {
    throw new WebhookBadRequestError("checkout.session.completed missing userId in metadata");
  }

  const checkoutType = session.metadata?.type;

  // Pack purchase (payment mode) vs subscription
  if (checkoutType === "pack") {
    return handlePackPurchase(session, userId);
  }

  // Subscription checkout
  const stripe = getStripe();
  const subscriptionId = session.subscription as string;
  if (!subscriptionId) {
    throw new WebhookBadRequestError("checkout.session.completed missing subscription ID");
  }

  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    throw new WebhookRetryableError(
      `Failed to retrieve subscription ${subscriptionId}: ${err instanceof Error ? err.message : err}`
    );
  }

  const subItem = subscription.items.data[0];
  const priceId = subItem?.price?.id;
  if (!priceId) {
    throw new WebhookBadRequestError("checkout.session.completed: subscription has no price ID");
  }

  const tierInfo = getTierFromPriceId(priceId);
  if (!tierInfo) {
    throw new WebhookBadRequestError(`Unknown price ID: ${priceId}`);
  }

  const periodStart = subItem.current_period_start;
  const periodEnd = subItem.current_period_end;

  try {
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
  } catch (err) {
    throw new WebhookRetryableError(
      `Failed to upsert subscription: ${err instanceof Error ? err.message : err}`
    );
  }

  // Sync image credit tier
  try {
    await updateTier(userId, tierInfo.tier);
  } catch (err) {
    throw new WebhookRetryableError(
      `Failed to sync image credit tier: ${err instanceof Error ? err.message : err}`
    );
  }

  console.log(
    `[stripe/webhook] Checkout completed: user=${userId} tier=${tierInfo.tier} interval=${tierInfo.interval}`
  );
}

async function handlePackPurchase(
  session: Stripe.Checkout.Session,
  userId: string
): Promise<void> {
  const packType = session.metadata?.packType;
  if (!packType) {
    throw new WebhookBadRequestError("Pack purchase missing packType in metadata");
  }

  const packDef = PACK_DEFINITIONS[packType];
  if (!packDef) {
    throw new WebhookBadRequestError(`Unknown pack type: ${packType}`);
  }

  const amountTotal = session.amount_total; // in cents

  try {
    const result = await addPack(userId, packType, {
      amountCents: amountTotal ?? 0,
      status: "completed",
    });

    console.log(
      `[stripe/webhook] Pack purchase succeeded: user=${userId} pack=${packType} credits=${result.credits} expires=${result.expiresAt}`
    );
  } catch (err) {
    throw new WebhookRetryableError(
      `Failed to create pack: ${err instanceof Error ? err.message : err}`
    );
  }
}

async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription
): Promise<void> {
  const userId = subscription.metadata?.userId;
  if (!userId) {
    throw new WebhookBadRequestError("subscription.updated missing userId in metadata");
  }

  const subItem = subscription.items.data[0];
  const priceId = subItem?.price?.id;
  if (!priceId) {
    throw new WebhookBadRequestError("subscription.updated: subscription has no price ID");
  }

  const tierInfo = getTierFromPriceId(priceId);
  if (!tierInfo) {
    throw new WebhookBadRequestError(`Unknown price ID in subscription.updated: ${priceId}`);
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

  try {
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
  } catch (err) {
    throw new WebhookRetryableError(
      `Failed to upsert subscription: ${err instanceof Error ? err.message : err}`
    );
  }

  // Sync image credit tier
  try {
    await updateTier(userId, tierInfo.tier);
  } catch (err) {
    throw new WebhookRetryableError(
      `Failed to sync image credit tier: ${err instanceof Error ? err.message : err}`
    );
  }

  // On renewal, reset monthly text credits
  if (isRenewal) {
    try {
      await resetMonthlyTextCredits(userId);
    } catch (err) {
      throw new WebhookRetryableError(
        `Failed to reset monthly text credits: ${err instanceof Error ? err.message : err}`
      );
    }
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
    throw new WebhookBadRequestError("subscription.deleted missing userId in metadata");
  }

  try {
    await upsertSubscription({
      userId,
      tier: "free",
      status: "cancelled",
      cancelAtPeriodEnd: false,
      firstMonth: false,
    });
  } catch (err) {
    throw new WebhookRetryableError(
      `Failed to upsert subscription: ${err instanceof Error ? err.message : err}`
    );
  }

  // Revert image credits to free tier
  try {
    await updateTier(userId, "free");
  } catch (err) {
    throw new WebhookRetryableError(
      `Failed to revert image credit tier: ${err instanceof Error ? err.message : err}`
    );
  }

  console.log(`[stripe/webhook] Subscription deleted: user=${userId} → free tier`);
}

async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const customerId = invoice.customer as string;
  if (!customerId) {
    throw new WebhookBadRequestError("invoice.payment_failed missing customer ID");
  }

  const sb = getSupabase();

  let data: { user_id: string; tier: string } | null;
  try {
    const result = await sb
      .from("subscriptions")
      .select("user_id, tier")
      .eq("stripe_customer_id", customerId)
      .single();
    data = result.data;
  } catch (err) {
    throw new WebhookRetryableError(
      `Failed to look up customer ${customerId}: ${err instanceof Error ? err.message : err}`
    );
  }

  if (!data) {
    throw new WebhookBadRequestError(`payment_failed: no user found for customer ${customerId}`);
  }

  try {
    await upsertSubscription({
      userId: data.user_id,
      tier: data.tier,
      status: "past_due",
    });
  } catch (err) {
    throw new WebhookRetryableError(
      `Failed to upsert subscription: ${err instanceof Error ? err.message : err}`
    );
  }

  console.log(`[stripe/webhook] Payment failed: user=${data.user_id} → past_due`);
}
