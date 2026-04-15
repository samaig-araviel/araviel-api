import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { getStripe, getPackPriceId, getApexUrl } from "@/lib/stripe";
import { getStripeCustomerId, upsertSubscription } from "@/lib/subscription";
import { PACK_DEFINITIONS } from "@/lib/credits";
import { corsHeaders, handleCorsOptions } from "../../cors";
import { requestContext, withRequestId } from "@/lib/request-context";
import { respondError, badRequest, internalError } from "@/lib/error-response";

export const runtime = "nodejs";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export const POST = withAuth(
  async (request: NextRequest, user: AuthenticatedUser) => {
    const origin = request.headers.get("origin");
    const ctx = requestContext(request, "stripe.checkout-pack");
    try {
      const body = await request.json();
      const { packType } = body;

      // Validate input
      if (!packType || !["starter", "creator", "studio"].includes(packType)) {
        throw badRequest(
          "Invalid packType. Must be 'starter', 'creator', or 'studio'.",
          "Please choose a valid credit pack."
        );
      }

      const packDef = PACK_DEFINITIONS[packType];
      if (!packDef) {
        throw internalError(
          "Pack definition not found",
          "That pack is not available right now."
        );
      }

      const priceId = getPackPriceId(packType);
      if (!priceId) {
        throw internalError(
          "Price configuration not found for pack",
          "That pack is not available right now."
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

      // Create Checkout Session for one-time payment
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "payment",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${apexUrl}/?checkout=success&type=pack`,
        cancel_url: `${apexUrl}/?view=usage`,
        metadata: {
          userId: user.id,
          packType,
          type: "pack",
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
  }
);
