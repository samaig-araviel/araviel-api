import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { getStripe, getPriceId, getApexUrl } from "@/lib/stripe";
import { getStripeCustomerId, upsertSubscription } from "@/lib/subscription";
import { corsHeaders, handleCorsOptions } from "../../cors";
import { requestContext, withRequestId } from "@/lib/request-context";
import { respondError, badRequest, internalError } from "@/lib/error-response";

export const runtime = "nodejs";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export const POST = withAuth(async (request: NextRequest, user: AuthenticatedUser) => {
  const origin = request.headers.get("origin");
  const ctx = requestContext(request, "stripe.checkout");
  try {
    const body = await request.json();
    const { tier, interval } = body;

    // Validate input
    if (!tier || !["lite", "pro"].includes(tier)) {
      throw badRequest(
        "Invalid tier. Must be 'lite' or 'pro'.",
        "Please pick a plan."
      );
    }
    if (!interval || !["monthly", "annual"].includes(interval)) {
      throw badRequest(
        "Invalid interval. Must be 'monthly' or 'annual'.",
        "Please pick a billing interval."
      );
    }

    const priceId = getPriceId(tier, interval);
    if (!priceId) {
      throw internalError(
        "Price configuration not found for this tier/interval.",
        "That plan isn't available right now."
      );
    }

    const stripe = getStripe();
    const apexUrl = getApexUrl();

    // Get or create Stripe customer
    let customerId = await getStripeCustomerId(user.id);

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { userId: user.id },
      });
      customerId = customer.id;

      // Store the customer ID in subscriptions table
      await upsertSubscription({
        userId: user.id,
        stripeCustomerId: customerId,
        tier: "free",
        status: "active",
      });
    }

    // Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${apexUrl}/?checkout=success`,
      cancel_url: `${apexUrl}/?view=pricing`,
      subscription_data: {
        metadata: {
          userId: user.id,
          tier,
          interval,
        },
      },
      metadata: {
        userId: user.id,
        tier,
        interval,
      },
    });

    return NextResponse.json(
      { url: session.url },
      {
        status: 200,
        headers: withRequestId(corsHeaders(origin), ctx.requestId),
      }
    );
  } catch (err) {
    return respondError(err, ctx.log, { requestId: ctx.requestId, origin });
  }
});
