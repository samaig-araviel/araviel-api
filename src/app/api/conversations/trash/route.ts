import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { getConversationTrashGraceDays } from "@/lib/conversation-trash";
import { corsHeaders, handleCorsOptions } from "../../cors";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function GET(request: NextRequest) {
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
    const supabase = getSupabase();
    const graceDays = getConversationTrashGraceDays();
    const cutoffMs = Date.now() - graceDays * 24 * 60 * 60 * 1000;

    const { data, error } = await supabase
      .from("conversations")
      .select("id, title, created_at, updated_at, project_id, deleted_at")
      .eq("user_id", user.id)
      .not("deleted_at", "is", null)
      .gte("deleted_at", new Date(cutoffMs).toISOString())
      .order("deleted_at", { ascending: false })
      .limit(200);

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    const conversations = (data ?? []).map((c) => {
      const deletedAtMs = new Date(c.deleted_at).getTime();
      const purgeAtMs = deletedAtMs + graceDays * 24 * 60 * 60 * 1000;
      return {
        id: c.id,
        title: c.title,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        projectId: c.project_id ?? null,
        deletedAt: c.deleted_at,
        purgeAt: new Date(purgeAtMs).toISOString(),
        daysRemaining: Math.max(0, Math.ceil((purgeAtMs - Date.now()) / (24 * 60 * 60 * 1000))),
      };
    });

    return NextResponse.json(
      { conversations, graceDays },
      { headers: corsHeaders(origin) }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
