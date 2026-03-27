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
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../cors";

export async function OPTIONS() {
  return handleCorsOptions();
}

/**
 * GET /api/credits
 * Returns the user's credit balance.
 */
export async function GET(request: NextRequest) {
  let user: AuthenticatedUser;
  try {
    user = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) {
      const headers = corsHeaders();
      headers["Cache-Control"] = "no-cache, no-store, max-age=0";
      return NextResponse.json({ error: err.message }, { status: err.status, headers });
    }
    throw err;
  }

  try {
    const balance = await getBalance(user.id);
    const headers = corsHeaders();
    headers["Cache-Control"] = "no-cache, no-store, max-age=0";
    return NextResponse.json(
      {
        balance,
        costs: IMAGE_QUALITY_COSTS,
        tiers: TIER_MONTHLY_CREDITS,
        packs: PACK_DEFINITIONS,
      },
      { headers }
    );
  } catch (err) {
    const headers = corsHeaders();
    headers["Cache-Control"] = "no-cache, no-store, max-age=0";
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get balance" },
      { status: 500, headers }
    );
  }
}

/**
 * POST /api/credits
 * Actions: "check", "buy-pack", "update-tier"
 */
export async function POST(request: NextRequest) {
  let user: AuthenticatedUser;
  try {
    user = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: corsHeaders() });
    }
    throw err;
  }

  try {
    const body = await request.json();
    const { action } = body;

    if (!action) {
      return NextResponse.json(
        { error: "action is required" },
        { status: 400, headers: corsHeaders() }
      );
    }

    switch (action) {
      case "check": {
        const quality = body.quality ?? "standard";
        const result = await canGenerate(user.id, quality);
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
        const result = await addPack(user.id, packType);
        const balance = await getBalance(user.id);
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
        await updateTier(user.id, tier);
        const balance = await getBalance(user.id);
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
