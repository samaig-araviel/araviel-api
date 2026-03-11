import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { corsHeaders, handleCorsOptions } from "../../cors";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("conversations")
      .select("id, title, created_at, updated_at, project_id")
      .eq("id", id)
      .single();

    if (error || !data) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404, headers: corsHeaders(request.headers.get("origin")) }
      );
    }

    return NextResponse.json(
      {
        id: data.id,
        title: data.title,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        projectId: data.project_id ?? null,
      },
      { headers: corsHeaders(request.headers.get("origin")) }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(request.headers.get("origin")) }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const origin = request.headers.get("origin");

  try {
    const { id } = await params;
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

    if (body.project_id !== undefined) {
      updates.project_id = body.project_id;
    }

    if (typeof body.title === "string") {
      updates.title = body.title.trim() || updates.title;
    }

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("conversations")
      .update(updates)
      .eq("id", id)
      .select("id, title, created_at, updated_at, project_id")
      .single();

    if (error) {
      const status = error.code === "PGRST116" ? 404 : 500;
      return NextResponse.json(
        { error: status === 404 ? "Conversation not found" : error.message },
        { status, headers: corsHeaders(origin) }
      );
    }

    return NextResponse.json(
      {
        id: data.id,
        title: data.title,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        projectId: data.project_id ?? null,
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

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const origin = request.headers.get("origin");

  try {
    const { id } = await params;
    const supabase = getSupabase();

    // Delete sub-conversation messages, sub-conversations, then messages, then conversation
    // 1. Find all sub-conversations for this conversation
    const { data: subConvs } = await supabase
      .from("sub_conversations")
      .select("id")
      .eq("conversation_id", id);

    if (subConvs && subConvs.length > 0) {
      const subIds = subConvs.map((sc: { id: string }) => sc.id);
      // 2. Delete sub-conversation messages
      await supabase
        .from("messages")
        .delete()
        .in("sub_conversation_id", subIds);
      // 3. Delete sub-conversations
      await supabase.from("sub_conversations").delete().eq("conversation_id", id);
    }

    // 4. Delete routing logs for messages in this conversation
    const { data: msgs } = await supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", id);

    if (msgs && msgs.length > 0) {
      const msgIds = msgs.map((m: { id: string }) => m.id);
      await supabase.from("routing_logs").delete().in("message_id", msgIds);
      await supabase.from("api_call_logs").delete().in("message_id", msgIds);
    }

    // 5. Delete messages
    await supabase.from("messages").delete().eq("conversation_id", id);

    // 6. Delete the conversation
    const { error } = await supabase
      .from("conversations")
      .delete()
      .eq("id", id);

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
