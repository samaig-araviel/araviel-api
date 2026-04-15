import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { getStripe, getApexUrl } from "@/lib/stripe";
import { getStripeCustomerId } from "@/lib/subscription";
import { corsHeaders, handleCorsOptions } from "../../cors";
import { requestContext, withRequestId } from "@/lib/request-context";
import { respondError, badRequest } from "@/lib/error-response";

export const runtime = "nodejs";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export const POST = withAuth(async (request: NextRequest, user: AuthenticatedUser) => {
  const origin = request.headers.get("origin");
  const ctx = requestContext(request, "stripe.portal");
  try {
    const customerId = await getStripeCustomerId(user.id);

    if (!customerId) {
      throw badRequest(
        "No active subscription found.",
        "You don't have an active subscription. Choose a plan to get started."
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
      {
        status: 200,
        headers: withRequestId(corsHeaders(origin), ctx.requestId),
      }
    );
  } catch (err) {
    return respondError(err, ctx.log, { requestId: ctx.requestId, origin });
  }
});
