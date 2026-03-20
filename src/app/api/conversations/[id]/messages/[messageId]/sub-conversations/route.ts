import { NextRequest, NextResponse } from "next/server";
import {
  createSubConversation,
  getSubConversations,
} from "@/lib/chat-helpers";
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
  let user: AuthenticatedUser;
  try {
    user = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: corsHeaders(request.headers.get("origin")) });
    }
    throw err;
  }

  try {
    const { id: conversationId, messageId } = await params;

    // Verify conversation ownership
    const { getSupabase } = await import("@/lib/supabase");
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
        { status: 404, headers: corsHeaders(request.headers.get("origin")) }
      );
    }
    const body = await request.json().catch(() => ({}));

    const highlightedText =
      typeof body.highlightedText === "string" && body.highlightedText.trim()
        ? body.highlightedText.trim()
        : null;

    if (!highlightedText) {
      return NextResponse.json(
        { error: "highlightedText is required and must be a non-empty string" },
        { status: 400, headers: corsHeaders(request.headers.get("origin")) }
      );
    }

    const subConv = await createSubConversation(
      conversationId,
      messageId,
      highlightedText
    );

    return NextResponse.json(
      {
        id: subConv.id,
        conversationId: subConv.conversation_id,
        parentMessageId: subConv.parent_message_id,
        highlightedText: subConv.highlighted_text,
        createdAt: subConv.created_at,
        updatedAt: subConv.updated_at,
      },
      { status: 201, headers: corsHeaders(request.headers.get("origin")) }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = message.includes("not found") ? 404 : 500;

    return NextResponse.json(
      { error: message },
      { status, headers: corsHeaders(request.headers.get("origin")) }
    );
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  let user: AuthenticatedUser;
  try {
    user = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: corsHeaders(request.headers.get("origin")) });
    }
    throw err;
  }

  try {
    const { id: conversationId, messageId } = await params;

    // Verify conversation ownership
    const { getSupabase } = await import("@/lib/supabase");
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
        { status: 404, headers: corsHeaders(request.headers.get("origin")) }
      );
    }

    const subConversations = await getSubConversations(messageId);

    const formatted = subConversations.map((sc) => ({
      id: sc.id,
      conversationId: sc.conversation_id,
      parentMessageId: sc.parent_message_id,
      highlightedText: sc.highlighted_text,
      isStarred: sc.is_starred ?? false,
      isArchived: sc.is_archived ?? false,
      isReported: sc.is_reported ?? false,
      createdAt: sc.created_at,
      updatedAt: sc.updated_at,
    }));

    return NextResponse.json(
      { subConversations: formatted },
      { headers: corsHeaders(request.headers.get("origin")) }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(request.headers.get("origin")) }
    );
  }
}
