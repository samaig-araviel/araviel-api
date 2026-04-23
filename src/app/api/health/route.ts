import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { buildAdeAuthHeaders } from "@/lib/ade-auth";
import { logger } from "@/lib/logger";
import { corsHeaders, handleCorsOptions } from "../cors";

const log = logger.child({ module: "health" });

const ADE_HEALTH_TIMEOUT_MS = 5_000;
const ADE_HEALTHY_STATUS = "healthy";

interface AdeHealthBody {
  status?: string;
}

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");

  const [supabaseOk, adeOk] = await Promise.all([
    checkSupabase(),
    checkAde(),
  ]);

  const allOk = supabaseOk && adeOk;

  return NextResponse.json(
    {
      status: allOk ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      services: {
        supabase: supabaseOk,
        ade: adeOk,
      },
    },
    {
      status: allOk ? 200 : 503,
      headers: corsHeaders(origin),
    }
  );
}

async function checkSupabase(): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from("conversations")
      .select("id", { count: "exact", head: true });
    return !error;
  } catch (err) {
    log.warn("Supabase health probe failed", undefined, err);
    return false;
  }
}

/**
 * Calls ADE's `/api/v1/health` endpoint with a signed service token
 * and the Layer 0 caller secret. Verifying the JSON body — not just
 * a status code — confirms the engine is actually ready and that our
 * outbound auth pipeline is producing valid credentials. A bare
 * connectivity probe (HEAD on the root) gave us false positives when
 * the deployment was up but the engine was crashing.
 */
async function checkAde(): Promise<boolean> {
  const baseUrl = process.env.ADE_BASE_URL ?? "https://ade-sandy.vercel.app";
  const url = `${baseUrl}/api/v1/health`;

  try {
    const headers = await buildAdeAuthHeaders();
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(ADE_HEALTH_TIMEOUT_MS),
    });

    if (!res.ok) {
      log.warn("ADE health probe returned non-OK status", { status: res.status });
      return false;
    }

    const body = (await res.json()) as AdeHealthBody;
    return body.status === ADE_HEALTHY_STATUS;
  } catch (err) {
    log.warn("ADE health probe failed", undefined, err);
    return false;
  }
}
