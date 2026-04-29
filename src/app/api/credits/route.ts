import { NextRequest, NextResponse } from "next/server";
import {
  getBalance,
  canGenerate,
  PACK_DEFINITIONS,
  IMAGE_QUALITY_COSTS,
  TIER_MONTHLY_CREDITS,
} from "@/lib/credits";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../cors";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

/**
 * GET /api/credits
 * Returns the user's credit balance.
 */
export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");

  let user: AuthenticatedUser;
  try {
    user = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) {
      const headers = corsHeaders(origin);
      headers["Cache-Control"] = "no-cache, no-store, max-age=0";
      return NextResponse.json({ error: err.message }, { status: err.status, headers });
    }
    throw err;
  }

  try {
    const balance = await getBalance(user.id);
    const headers = corsHeaders(origin);
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
    const headers = corsHeaders(origin);
    headers["Cache-Control"] = "no-cache, no-store, max-age=0";
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to get balance" },
      { status: 500, headers }
    );
  }
}

/**
 * POST /api/credits
 * Actions: "check"
 *
 * Note: credit provisioning (buy-pack, update-tier) is handled exclusively
 * by the Stripe webhook handler to ensure payment is verified before credits
 * are granted. Direct self-service mutations have been removed.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");

  let user: AuthenticatedUser;
  try {
    user = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status, headers: corsHeaders(origin) }
      );
    }
    throw err;
  }

  try {
    const body = await request.json();
    const { action } = body;

    if (!action) {
      return NextResponse.json(
        { error: "action is required" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    switch (action) {
      case "check": {
        const quality = body.quality ?? "standard";
        const result = await canGenerate(user.id, quality);
        return NextResponse.json(result, { headers: corsHeaders(origin) });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400, headers: corsHeaders(origin) }
        );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
