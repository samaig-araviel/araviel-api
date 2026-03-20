import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../../../cors";

const VALID_REASONS = ["harmful", "inaccurate", "inappropriate", "other"] as const;

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subId: string }> }
) {
  const origin = request.headers.get("origin");

  let user: AuthenticatedUser;
  try {
    user = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: corsHeaders(origin) });
    }
    throw err;
  }

  try {
    const { subId } = await params;

    // Verify ownership via parent conversation
    const supabaseCheck = getSupabase();
    const { data: subConv, error: subErr } = await supabaseCheck
      .from("sub_conversations")
      .select("conversation_id")
      .eq("id", subId)
      .single();

    if (subErr || !subConv) {
      return NextResponse.json(
        { error: "Sub-conversation not found" },
        { status: 404, headers: corsHeaders(origin) }
      );
    }

    const { data: conv, error: convErr } = await supabaseCheck
      .from("conversations")
      .select("id")
      .eq("id", subConv.conversation_id)
      .eq("user_id", user.id)
      .single();

    if (convErr || !conv) {
      return NextResponse.json(
        { error: "Sub-conversation not found" },
        { status: 404, headers: corsHeaders(origin) }
      );
    }
    const body = await request.json().catch(() => null);

    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Request body is required" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    const { reason, details } = body;

    if (
      typeof reason !== "string" ||
      !VALID_REASONS.includes(reason as (typeof VALID_REASONS)[number])
    ) {
      return NextResponse.json(
        {
          error: `Invalid reason. Must be one of: ${VALID_REASONS.join(", ")}`,
        },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    const supabase = getSupabase();

    // 1. Insert into sub_conversation_reports
    const { error: reportError } = await supabase
      .from("sub_conversation_reports")
      .insert({
        sub_conversation_id: subId,
        reason,
        details: typeof details === "string" ? details.trim() : null,
      });

    if (reportError) {
      return NextResponse.json(
        { error: reportError.message },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    // 2. Mark sub-conversation as reported
    const { error: updateError } = await supabase
      .from("sub_conversations")
      .update({
        is_reported: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", subId);

    if (updateError) {
      return NextResponse.json(
        { error: updateError.message },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    return NextResponse.json(
      { success: true },
      { headers: corsHeaders(origin) }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
