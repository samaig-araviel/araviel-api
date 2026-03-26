import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { getStripe, getApexUrl } from "@/lib/stripe";
import { getStripeCustomerId } from "@/lib/subscription";
import { corsHeaders, handleCorsOptions } from "../../cors";

export const runtime = "nodejs";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export const POST = withAuth(async (request: NextRequest, user: AuthenticatedUser) => {
  const origin = request.headers.get("origin");
  try {
    const customerId = await getStripeCustomerId(user.id);

    if (!customerId) {
      return NextResponse.json(
        { error: "No active subscription found. Subscribe first." },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    const stripe = getStripe();
    const apexUrl = getApexUrl();

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${apexUrl}/?view=settings`,
    });

    return NextResponse.json(
      { url: session.url },
      { status: 200, headers: corsHeaders(origin) }
    );
  } catch (err) {
    console.error("[stripe/portal] Error:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Failed to create portal session" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
});
