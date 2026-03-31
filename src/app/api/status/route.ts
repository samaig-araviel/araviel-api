import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { corsHeaders, handleCorsOptions } from "../cors";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");
  const supabase = getSupabase();

  try {
    // Fetch latest status per provider (most recent row each)
    const { data: providerRows } = await supabase
      .from("provider_status")
      .select("*")
      .order("checked_at", { ascending: false })
      .limit(30);

    // Deduplicate to latest per provider
    const providerMap: Record<string, Record<string, unknown>> = {};
    for (const row of providerRows ?? []) {
      if (!providerMap[row.provider]) {
        providerMap[row.provider] = row;
      }
    }

    // Fetch latest platform status per service
    const { data: platformRows } = await supabase
      .from("platform_status")
      .select("*")
      .order("checked_at", { ascending: false })
      .limit(15);

    const platformMap: Record<string, Record<string, unknown>> = {};
    for (const row of platformRows ?? []) {
      if (!platformMap[row.service as string]) {
        platformMap[row.service as string] = row;
      }
    }

    // Build response
    const providers: Record<string, unknown> = {};
    for (const [name, row] of Object.entries(providerMap)) {
      providers[name] = {
        status: row.status,
        latencyMs: row.latency_ms,
        healthCheckOk: row.health_check_ok,
        successRate: row.success_rate ?? null,
        errorRate: row.error_rate ?? null,
        avgResponseMs: row.avg_response_ms ?? null,
        statusPageRaw: row.status_page_raw,
        incidents: row.incidents,
        lastChecked: row.checked_at,
      };
    }

    const platform: Record<string, unknown> = {};
    for (const [name, row] of Object.entries(platformMap)) {
      platform[name] = {
        status: row.status,
        latencyMs: row.latency_ms,
        errorMessage: row.error_message,
        lastChecked: row.checked_at,
      };
    }

    // Determine overall status
    let overall = "operational";
    const severityOrder = ["operational", "degraded", "partial_outage", "major_outage"];
    for (const p of Object.values(providerMap)) {
      const idx = severityOrder.indexOf(p.status as string);
      if (idx > severityOrder.indexOf(overall)) overall = p.status as string;
    }
    for (const s of Object.values(platformMap)) {
      const status = s.status === "down" ? "major_outage" : (s.status as string);
      const idx = severityOrder.indexOf(status);
      if (idx > severityOrder.indexOf(overall)) overall = status;
    }

    return NextResponse.json(
      {
        providers,
        platform,
        overall,
        timestamp: new Date().toISOString(),
      },
      { headers: corsHeaders(origin) }
    );
  } catch (err) {
    console.error("[status] Error:", err);
    return NextResponse.json(
      { error: "Failed to fetch status" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
