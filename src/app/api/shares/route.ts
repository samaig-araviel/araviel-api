import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../cors";

/**
 * GET /api/shares
 *
 * Lists active shares belonging to the authenticated user. Drives the
 * Settings > Shared chats management UI (mirrors Claude's
 * Settings > Privacy > Manage).
 */

interface DBSharedConversationListRow {
  share_token: string;
  conversation_id: string;
  title_snapshot: string | null;
  snapshot_at: string;
  created_at: string;
  view_count: number;
}

interface SharedConversationListItem {
  shareToken: string;
  conversationId: string;
  title: string | null;
  snapshotAt: string;
  createdAt: string;
  viewCount: number;
}

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

    const { data, error } = await supabase
      .from("shared_conversations")
      .select("share_token, conversation_id, title_snapshot, snapshot_at, created_at, view_count")
      .eq("user_id", user.id)
      .is("revoked_at", null)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    const shares: SharedConversationListItem[] = (
      (data ?? []) as DBSharedConversationListRow[]
    ).map((row) => ({
      shareToken: row.share_token,
      conversationId: row.conversation_id,
      title: row.title_snapshot,
      snapshotAt: row.snapshot_at,
      createdAt: row.created_at,
      viewCount: row.view_count,
    }));

    return NextResponse.json(
      { shares },
      { headers: corsHeaders(origin) }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
