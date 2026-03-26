import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { getUserSubscription, getOrCreateDailyCredits } from "@/lib/subscription";
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

    const credits = await getOrCreateDailyCredits(user.id, tier, firstMonth);

    return NextResponse.json(
      {
        tier,
        status: subscription?.status ?? "active",
        billingInterval: subscription?.billingInterval ?? null,
        credits: {
          used: credits.creditsUsed,
          limit: credits.creditsLimit,
          bonus: credits.bonusCredits,
        },
        periodEnd: subscription?.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
        firstMonth,
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
