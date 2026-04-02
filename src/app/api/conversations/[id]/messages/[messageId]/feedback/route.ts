import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSupabase } from "@/lib/supabase";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../../../../../cors";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> }
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
    const { id: conversationId, messageId } = await params;

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

    const { feedback, details, comment } = body;

    if (feedback !== null && feedback !== "like" && feedback !== "dislike") {
      return NextResponse.json(
        { error: "Invalid feedback. Must be \"like\", \"dislike\", or null" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    if (details !== undefined && details !== null && (!Array.isArray(details) || !details.every((d: unknown) => typeof d === "string"))) {
      return NextResponse.json(
        { error: "Invalid details. Must be an array of strings or null" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    if (comment !== undefined && comment !== null && typeof comment !== "string") {
      return NextResponse.json(
        { error: "Invalid comment. Must be a string or null" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    const supabase = getSupabase();

    if (feedback === null) {
      // Delete existing feedback
      const { error } = await supabase
        .from("message_feedback")
        .delete()
        .eq("message_id", messageId);

      if (error) {
        return NextResponse.json(
          { error: error.message },
          { status: 500, headers: corsHeaders(origin) }
        );
      }

      return NextResponse.json(
        { success: true, feedback: null },
        { headers: corsHeaders(origin) }
      );
    }

    // Upsert feedback
    const { error } = await supabase
      .from("message_feedback")
      .upsert(
        {
          id: randomUUID(),
          message_id: messageId,
          conversation_id: conversationId,
          feedback,
          details: details || null,
          comment: comment || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "message_id" }
      );

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    return NextResponse.json(
      { success: true, feedback },
      { headers: corsHeaders(origin) }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
