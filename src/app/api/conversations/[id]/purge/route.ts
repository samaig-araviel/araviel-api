import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../../../cors";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function DELETE(
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
    const { id } = await params;
    const supabase = getSupabase();

    const { data: owned, error: ownErr } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .not("deleted_at", "is", null)
      .single();

    if (ownErr || !owned) {
      return NextResponse.json(
        { error: "Conversation not found in Recently deleted" },
        { status: 404, headers: corsHeaders(origin) }
      );
    }

    const { data: subConvs } = await supabase
      .from("sub_conversations")
      .select("id")
      .eq("conversation_id", id);

    if (subConvs && subConvs.length > 0) {
      const subIds = subConvs.map((sc: { id: string }) => sc.id);
      await supabase.from("messages").delete().in("sub_conversation_id", subIds);
      await supabase.from("sub_conversation_reports").delete().in("sub_conversation_id", subIds);
      await supabase.from("sub_conversations").delete().eq("conversation_id", id);
    }

    const { data: msgs } = await supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", id);

    if (msgs && msgs.length > 0) {
      const msgIds = msgs.map((m: { id: string }) => m.id);
      await supabase.from("routing_logs").delete().in("message_id", msgIds);
      await supabase.from("api_call_logs").delete().in("message_id", msgIds);
      await supabase.from("message_feedback").delete().in("message_id", msgIds);
    }

    await supabase.from("messages").delete().eq("conversation_id", id);
    await supabase.from("conversation_reports").delete().eq("conversation_id", id);
    await supabase.from("shared_conversations").delete().eq("conversation_id", id);

    const { error } = await supabase.from("conversations").delete().eq("id", id);

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
