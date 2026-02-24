import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { corsHeaders, handleCorsOptions } from "../cors";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");

  let supabaseOk = false;
  let adeOk = false;

  // Check Supabase
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from("conversations")
      .select("id", { count: "exact", head: true });
    supabaseOk = !error;
  } catch {
    supabaseOk = false;
  }

  // Check ADE
  try {
    const baseUrl = process.env.ADE_BASE_URL ?? "https://ade-sandy.vercel.app";
    const res = await fetch(baseUrl, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    adeOk = res.ok || res.status === 405 || res.status === 404;
  } catch {
    adeOk = false;
  }

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
