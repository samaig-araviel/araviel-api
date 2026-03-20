import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../../cors";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function DELETE(
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
    const supabase = getSupabase();

    // Verify ownership via parent conversation
    const { data: subConv, error: subErr } = await supabase
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

    const { data: conv, error: convErr } = await supabase
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

    // 1. Delete messages belonging to this sub-conversation
    await supabase
      .from("messages")
      .delete()
      .eq("sub_conversation_id", subId);

    // 2. Delete the sub-conversation itself
    const { error } = await supabase
      .from("sub_conversations")
      .delete()
      .eq("id", subId);

    if (error) {
      return NextResponse.json(
        { error: error.message },
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

export async function PATCH(
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
    const { data: subConvCheck, error: subCheckErr } = await supabaseCheck
      .from("sub_conversations")
      .select("conversation_id")
      .eq("id", subId)
      .single();

    if (subCheckErr || !subConvCheck) {
      return NextResponse.json(
        { error: "Sub-conversation not found" },
        { status: 404, headers: corsHeaders(origin) }
      );
    }

    const { data: convCheck, error: convCheckErr } = await supabaseCheck
      .from("conversations")
      .select("id")
      .eq("id", subConvCheck.conversation_id)
      .eq("user_id", user.id)
      .single();

    if (convCheckErr || !convCheck) {
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

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (typeof body.is_starred === "boolean") {
      updates.is_starred = body.is_starred;
    }

    if (typeof body.is_archived === "boolean") {
      updates.is_archived = body.is_archived;
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("sub_conversations")
      .update(updates)
      .eq("id", subId)
      .select(
        "id, conversation_id, parent_message_id, highlighted_text, is_starred, is_archived, is_reported, created_at, updated_at"
      )
      .single();

    if (error) {
      const status = error.code === "PGRST116" ? 404 : 500;
      return NextResponse.json(
        {
          error:
            status === 404
              ? "Sub-conversation not found"
              : error.message,
        },
        { status, headers: corsHeaders(origin) }
      );
    }

    return NextResponse.json(
      {
        id: data.id,
        conversationId: data.conversation_id,
        parentMessageId: data.parent_message_id,
        highlightedText: data.highlighted_text,
        isStarred: data.is_starred,
        isArchived: data.is_archived,
        isReported: data.is_reported,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      },
      { headers: corsHeaders(origin) }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
