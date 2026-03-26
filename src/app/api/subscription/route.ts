import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { getUserSubscription, getTextCreditState } from "@/lib/subscription";
import { getBalance } from "@/lib/credits";
import { corsHeaders, handleCorsOptions } from "../cors";

export const runtime = "nodejs";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export const GET = withAuth(async (request: NextRequest, user: AuthenticatedUser) => {
  const origin = request.headers.get("origin");
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
      { status: 200, headers: corsHeaders(origin) }
    );
  } catch (err) {
    console.error("[subscription] Error fetching subscription:", err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: "Failed to fetch subscription" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
});
