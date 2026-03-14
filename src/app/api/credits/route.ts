import { NextRequest, NextResponse } from "next/server";
import {
  getBalance,
  canGenerate,
  addPack,
  updateTier,
  PACK_DEFINITIONS,
  IMAGE_QUALITY_COSTS,
  TIER_MONTHLY_CREDITS,
} from "@/lib/credits";
import { corsHeaders, handleCorsOptions } from "../cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * GET /api/credits?userId=...
 * Returns the user's credit balance.
 */
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json(
      { error: "userId is required" },
      { status: 400, headers: corsHeaders() }
    );
  }

  try {
    const balance = await getBalance(userId);
    return NextResponse.json(
      {
        balance,
        costs: IMAGE_QUALITY_COSTS,
        tiers: TIER_MONTHLY_CREDITS,
        packs: PACK_DEFINITIONS,
      },
      { headers: corsHeaders() }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get balance" },
      { status: 500, headers: corsHeaders() }
    );
  }
}

/**
 * POST /api/credits
 * Actions: "check", "buy-pack", "update-tier"
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, userId } = body;

    if (!userId || !action) {
      return NextResponse.json(
        { error: "userId and action are required" },
        { status: 400, headers: corsHeaders() }
      );
    }

    switch (action) {
      case "check": {
        const quality = body.quality ?? "standard";
        const result = await canGenerate(userId, quality);
        return NextResponse.json(result, { headers: corsHeaders() });
      }

      case "buy-pack": {
        const packType = body.packType;
        if (!packType || !PACK_DEFINITIONS[packType]) {
          return NextResponse.json(
            { error: `Invalid pack type. Choose: ${Object.keys(PACK_DEFINITIONS).join(", ")}` },
            { status: 400, headers: corsHeaders() }
          );
        }
        const result = await addPack(userId, packType);
        const balance = await getBalance(userId);
        return NextResponse.json({ ...result, balance }, { headers: corsHeaders() });
      }

      case "update-tier": {
        const tier = body.tier;
        if (!tier || !TIER_MONTHLY_CREDITS[tier]) {
          return NextResponse.json(
            { error: `Invalid tier. Choose: ${Object.keys(TIER_MONTHLY_CREDITS).join(", ")}` },
            { status: 400, headers: corsHeaders() }
          );
        }
        await updateTier(userId, tier);
        const balance = await getBalance(userId);
        return NextResponse.json({ tier, balance }, { headers: corsHeaders() });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400, headers: corsHeaders() }
        );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders() }
    );
  }
}
