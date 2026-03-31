import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { corsHeaders, handleCorsOptions } from "../../cors";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");
  const { searchParams } = new URL(request.url);

  const type = searchParams.get("type") ?? "provider";
  const hours = Math.min(Number(searchParams.get("hours") ?? 24), 720);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const supabase = getSupabase();

  try {
    if (type === "platform") {
      const service = searchParams.get("service");
      let query = supabase
        .from("platform_status")
        .select("service, status, latency_ms, checked_at")
        .gte("checked_at", since)
        .order("checked_at", { ascending: true })
        .limit(1000);

      if (service) query = query.eq("service", service);

      const { data, error } = await query;
      if (error) throw error;

      return NextResponse.json(
        { type: "platform", hours, data: data ?? [] },
        { headers: corsHeaders(origin) }
      );
    }

    // Default: provider history
    const provider = searchParams.get("provider");
    let query = supabase
      .from("provider_status_history")
      .select(
        "provider, status, latency_ms, success_rate, error_rate, avg_response_ms, checked_at"
      )
      .gte("checked_at", since)
      .order("checked_at", { ascending: true })
      .limit(1500);

    if (provider) query = query.eq("provider", provider);

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json(
      { type: "provider", hours, data: data ?? [] },
      { headers: corsHeaders(origin) }
    );
  } catch (err) {
    console.error("[status/history] Error:", err);
    return NextResponse.json(
      { error: "Failed to fetch status history" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
