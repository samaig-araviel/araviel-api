import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
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
  { params }: { params: Promise<{ id: string }> }
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
    const { id: conversationId } = await params;

    // Verify conversation ownership
    const supabaseCheck = getSupabase();
    const { data: conv, error: convErr } = await supabaseCheck
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("user_id", user.id)
      .single();

    if (convErr || !conv) {
      return NextResponse.json(
        { error: "Conversation not found" },
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

    if (!reason || !VALID_REASONS.includes(reason)) {
      return NextResponse.json(
        { error: `Invalid reason. Must be one of: ${VALID_REASONS.join(", ")}` },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    const supabase = getSupabase();

    // Insert the report
    const { error: reportError } = await supabase
      .from("conversation_reports")
      .insert({
        id: randomUUID(),
        conversation_id: conversationId,
        reason,
        details: details ?? null,
        created_at: new Date().toISOString(),
      });

    if (reportError) {
      return NextResponse.json(
        { error: reportError.message },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    // Update conversation to mark as reported
    const { error: updateError } = await supabase
      .from("conversations")
      .update({ is_reported: true, updated_at: new Date().toISOString() })
      .eq("id", conversationId);

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
