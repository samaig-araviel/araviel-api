import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { getUserSubscription, getTextCreditState } from "@/lib/subscription";
import { getBalance } from "@/lib/credits";
import { corsHeaders, handleCorsOptions } from "../cors";
import { requestContext, withRequestId } from "@/lib/request-context";
import { respondError } from "@/lib/error-response";

export const runtime = "nodejs";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export const GET = withAuth(async (request: NextRequest, user: AuthenticatedUser) => {
  const origin = request.headers.get("origin");
  const ctx = requestContext(request, "subscription.get");
  try {
    const subscription = await getUserSubscription(user.id);
    const tier = subscription?.tier ?? "free";
    const firstMonth = subscription?.firstMonth ?? false;

    // Get text credit state (monthly + window)
    const textCredits = await getTextCreditState(user.id, tier, firstMonth);

    // Get image credit balance
    const imageBalance = await getBalance(user.id);

    return NextResponse.json(
      {
        tier,
        status: subscription?.status ?? "active",
        billingInterval: subscription?.billingInterval ?? null,
        periodEnd: subscription?.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
        firstMonth,
        textCredits: {
          monthlyUsed: textCredits.monthlyUsed,
          monthlyLimit: textCredits.monthlyLimit,
          windowUsed: textCredits.windowUsed,
          windowLimit: textCredits.windowLimit,
          windowResetAt: textCredits.windowResetAt,
        },
        imageCredits: {
          used: imageBalance.monthly.used,
          limit: imageBalance.monthly.total,
          remaining: imageBalance.monthly.remaining,
          packRemaining: imageBalance.packs.remaining,
          cycleResetsAt: imageBalance.cycleResetsAt,
        },
      },
      {
        status: 200,
        headers: withRequestId(corsHeaders(origin), ctx.requestId),
      }
    );
  } catch (err) {
    return respondError(err, ctx.log, { requestId: ctx.requestId, origin });
  }
});
