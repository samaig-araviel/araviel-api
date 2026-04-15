import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../../../cors";

/**
 * Owner-only endpoints for managing a conversation's public share link.
 *
 *   POST   → create (or return existing) active share
 *   PATCH  → refresh snapshot_at to include newer messages
 *   DELETE → revoke the active share
 *
 * The public read endpoint lives at GET /api/shares/[token].
 */

interface DBSharedConversation {
  share_token: string;
  conversation_id: string;
  user_id: string;
  title_snapshot: string | null;
  snapshot_at: string;
  created_at: string;
  revoked_at: string | null;
  view_count: number;
}

interface ShareResponse {
  shareToken: string;
  conversationId: string;
  snapshotAt: string;
  createdAt: string;
  titleSnapshot: string | null;
  viewCount: number;
}

function serializeShare(row: DBSharedConversation): ShareResponse {
  return {
    shareToken: row.share_token,
    conversationId: row.conversation_id,
    snapshotAt: row.snapshot_at,
    createdAt: row.created_at,
    titleSnapshot: row.title_snapshot,
    viewCount: row.view_count,
  };
}

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

/**
 * POST /api/conversations/:id/share
 *
 * Creates a new active share or, if one already exists, returns it (refreshing
 * snapshot_at so the link reflects the current conversation state). The
 * partial unique index on (conversation_id) WHERE revoked_at IS NULL
 * guarantees we never end up with two active shares for the same conversation.
 */
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
    const supabase = getSupabase();

    // Verify the conversation exists and belongs to the authenticated user.
    const { data: conversation, error: convErr } = await supabase
      .from("conversations")
      .select("id, title, user_id")
      .eq("id", conversationId)
      .eq("user_id", user.id)
      .single();

    if (convErr || !conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404, headers: corsHeaders(origin) }
      );
    }

    const nowIso = new Date().toISOString();

    // If an active share already exists, refresh its snapshot and return it.
    const { data: existing } = await supabase
      .from("shared_conversations")
      .select("*")
      .eq("conversation_id", conversationId)
      .is("revoked_at", null)
      .maybeSingle();

    if (existing) {
      const { data: refreshed, error: refreshErr } = await supabase
        .from("shared_conversations")
        .update({ snapshot_at: nowIso, title_snapshot: conversation.title })
        .eq("share_token", (existing as DBSharedConversation).share_token)
        .select("*")
        .single();

      if (refreshErr || !refreshed) {
        return NextResponse.json(
          { error: refreshErr?.message ?? "Failed to refresh share" },
          { status: 500, headers: corsHeaders(origin) }
        );
      }

      return NextResponse.json(serializeShare(refreshed as DBSharedConversation), {
        headers: corsHeaders(origin),
      });
    }

    // Otherwise insert a new active share row. The DB generates the UUID token.
    const { data: inserted, error: insertErr } = await supabase
      .from("shared_conversations")
      .insert({
        conversation_id: conversationId,
        user_id: user.id,
        title_snapshot: conversation.title,
      })
      .select("*")
      .single();

    if (insertErr || !inserted) {
      return NextResponse.json(
        { error: insertErr?.message ?? "Failed to create share" },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    return NextResponse.json(serializeShare(inserted as DBSharedConversation), {
      status: 201,
      headers: corsHeaders(origin),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}

/**
 * PATCH /api/conversations/:id/share
 *
 * Refreshes the snapshot_at cutoff on the active share so viewers see any
 * messages sent since the share was first created. 404 if no active share.
 */
export async function PATCH(
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
    const supabase = getSupabase();

    const { data: conversation, error: convErr } = await supabase
      .from("conversations")
      .select("id, title")
      .eq("id", conversationId)
      .eq("user_id", user.id)
      .single();

    if (convErr || !conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404, headers: corsHeaders(origin) }
      );
    }

    const { data: updated, error: updateErr } = await supabase
      .from("shared_conversations")
      .update({
        snapshot_at: new Date().toISOString(),
        title_snapshot: conversation.title,
      })
      .eq("conversation_id", conversationId)
      .eq("user_id", user.id)
      .is("revoked_at", null)
      .select("*")
      .single();

    if (updateErr || !updated) {
      const status = updateErr?.code === "PGRST116" ? 404 : 500;
      return NextResponse.json(
        { error: status === 404 ? "No active share link for this conversation" : (updateErr?.message ?? "Failed to update share") },
        { status, headers: corsHeaders(origin) }
      );
    }

    return NextResponse.json(serializeShare(updated as DBSharedConversation), {
      headers: corsHeaders(origin),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}

/**
 * DELETE /api/conversations/:id/share
 *
 * Revokes the active share by setting revoked_at. Future public lookups by
 * token return 404. The row is kept for auditing and to free the partial
 * unique index so a new share can be created later.
 */
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
    const { id: conversationId } = await params;
    const supabase = getSupabase();

    const { data: revoked, error: revokeErr } = await supabase
      .from("shared_conversations")
      .update({ revoked_at: new Date().toISOString() })
      .eq("conversation_id", conversationId)
      .eq("user_id", user.id)
      .is("revoked_at", null)
      .select("share_token")
      .maybeSingle();

    if (revokeErr) {
      return NextResponse.json(
        { error: revokeErr.message },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    if (!revoked) {
      return NextResponse.json(
        { error: "No active share link for this conversation" },
        { status: 404, headers: corsHeaders(origin) }
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

/**
 * GET /api/conversations/:id/share
 *
 * Returns the active share for the conversation (owner-only). Used by the
 * share modal to render "Update" / "Unshare" state without calling POST.
 */
export async function GET(
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
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("shared_conversations")
      .select("*")
      .eq("conversation_id", conversationId)
      .eq("user_id", user.id)
      .is("revoked_at", null)
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    if (!data) {
      return NextResponse.json(
        { share: null },
        { headers: corsHeaders(origin) }
      );
    }

    return NextResponse.json(
      { share: serializeShare(data as DBSharedConversation) },
      { headers: corsHeaders(origin) }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
