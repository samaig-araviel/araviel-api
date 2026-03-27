import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { getStripe, getPackPriceId, getApexUrl } from "@/lib/stripe";
import { getStripeCustomerId, upsertSubscription } from "@/lib/subscription";
import { PACK_DEFINITIONS } from "@/lib/credits";
import { corsHeaders, handleCorsOptions } from "../../cors";

export const runtime = "nodejs";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export const POST = withAuth(
  async (request: NextRequest, user: AuthenticatedUser) => {
    const origin = request.headers.get("origin");
    try {
      const body = await request.json();
      const { packType } = body;

      // Validate input
      if (!packType || !["starter", "creator", "studio"].includes(packType)) {
        return NextResponse.json(
          {
            error:
              "Invalid packType. Must be 'starter', 'creator', or 'studio'.",
          },
          { status: 400, headers: corsHeaders(origin) }
        );
      }

      const packDef = PACK_DEFINITIONS[packType];
      if (!packDef) {
        return NextResponse.json(
          { error: "Pack definition not found" },
          { status: 500, headers: corsHeaders(origin) }
        );
      }

      const priceId = getPackPriceId(packType);
      if (!priceId) {
        return NextResponse.json(
          { error: "Price configuration not found for this pack." },
          { status: 500, headers: corsHeaders(origin) }
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
        { status: 200, headers: corsHeaders(origin) }
      );
    } catch (err) {
      console.error(
        "[stripe/checkout-pack] Error:",
        err instanceof Error ? err.message : err
      );
      return NextResponse.json(
        { error: "Failed to create checkout session" },
        { status: 500, headers: corsHeaders(origin) }
      );
    }
  }
);
