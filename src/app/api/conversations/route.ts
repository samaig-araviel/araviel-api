import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSupabase } from "@/lib/supabase";
import { corsHeaders, handleCorsOptions } from "../cors";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "20", 10), 100);
    const offset = parseInt(searchParams.get("offset") ?? "0", 10);

    const supabase = getSupabase();

    const [{ data, error }, { count, error: countError }] = await Promise.all([
      supabase
        .from("conversations")
        .select("id, title, created_at, updated_at")
        .order("updated_at", { ascending: false })
        .range(offset, offset + limit - 1),
      supabase
        .from("conversations")
        .select("id", { count: "exact", head: true }),
    ]);

    if (error || countError) {
      return NextResponse.json(
        { error: (error ?? countError)?.message },
        { status: 500, headers: corsHeaders(request.headers.get("origin")) }
      );
    }

    const conversations = (data ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    }));

    return NextResponse.json(
      { conversations, total: count ?? 0 },
      { headers: corsHeaders(request.headers.get("origin")) }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(request.headers.get("origin")) }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const title = typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : "New conversation";

    const supabase = getSupabase();
    const id = randomUUID();
    const now = new Date().toISOString();

    const { error } = await supabase.from("conversations").insert({
      id,
      title,
      created_at: now,
      updated_at: now,
    });

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: corsHeaders(request.headers.get("origin")) }
      );
    }

    return NextResponse.json(
      { id, title, createdAt: now, updatedAt: now },
      { status: 201, headers: corsHeaders(request.headers.get("origin")) }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(request.headers.get("origin")) }
    );
  }
}
