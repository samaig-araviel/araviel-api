import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import type { Citation, FollowUpQuestion, ModelInfo } from "@/lib/types";
import { rateLimit, rateLimitHeaders } from "@/lib/rateLimit";
import { corsHeaders, handleCorsOptions } from "../../cors";

/**
 * Public, unauthenticated endpoint that returns a read-only snapshot of a
 * shared conversation.
 *
 * Privacy rules:
 *   * No auth required → must NEVER expose the owner's user_id, email, or
 *     internal telemetry (cost, tokens, latency).
 *   * File attachments uploaded by the user are stripped (Claude-style
 *     privacy: the conversation is shared but the files stay private).
 *   * Raw tool-call payloads are stripped; only the final rendered thinking
 *     output is kept.
 *   * If the share has been revoked or the owner reported the conversation,
 *     we return 404 rather than leaking that the token ever existed.
 *
 * Performance:
 *   * Two indexed queries: one for the share row, one for messages with
 *     created_at ≤ snapshot_at. No N+1.
 *   * view_count increment is fire-and-forget so viewers don't wait on it.
 *   * Rate-limited per IP to deter scrapers.
 */

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface DBSharedConversationRow {
  share_token: string;
  conversation_id: string;
  title_snapshot: string | null;
  snapshot_at: string;
  created_at: string;
  revoked_at: string | null;
}

interface DBConversationRow {
  id: string;
  title: string;
  created_at: string;
  is_reported: boolean | null;
}

interface DBMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
  model_used: Record<string, unknown> | null;
  extended_data: Record<string, unknown> | null;
}

interface PublicMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  model?: ModelInfo | null;
  thinkingContent?: string | null;
  citations?: Citation[] | null;
  followUps?: string[] | null;
  questions?: FollowUpQuestion[] | null;
}

interface PublicSharePayload {
  shareToken: string;
  title: string;
  snapshotAt: string;
  sharedAt: string;
  messages: PublicMessage[];
}

/**
 * Headers that make share pages un-indexable and disallow framing from other
 * origins. Applied to both successful and revoked responses so search crawlers
 * don't cache 404s as indexable either.
 */
const PUBLIC_RESPONSE_HEADERS: Record<string, string> = {
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "private, no-store",
};

function buildHeaders(
  origin: string | null,
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    ...corsHeaders(origin),
    ...PUBLIC_RESPONSE_HEADERS,
    ...extra,
  };
}

/**
 * Strip a raw message row down to the rendering-only fields a read-only
 * viewer should see. Telemetry (tokens, cost, latency), uploaded attachments,
 * and raw tool-call payloads are dropped.
 */
function toPublicMessage(msg: DBMessageRow): PublicMessage {
  const base: PublicMessage = {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    createdAt: msg.created_at,
  };

  if (msg.role !== "assistant") {
    return base;
  }

  const modelUsed = msg.model_used as { model?: ModelInfo } | null;
  const extendedData = msg.extended_data as {
    thinkingContent?: string;
    citations?: Citation[];
    followUps?: string[];
    questions?: FollowUpQuestion[];
  } | null;

  return {
    ...base,
    model: modelUsed?.model ?? null,
    thinkingContent: extendedData?.thinkingContent ?? null,
    citations: extendedData?.citations ?? null,
    followUps: extendedData?.followUps ?? null,
    questions: extendedData?.questions ?? null,
  };
}

/**
 * Fire-and-forget atomic increment of view_count. We don't await the result
 * so the viewer's response isn't delayed, and an RPC failure is swallowed:
 * analytics must never cause the page to 500.
 */
function recordView(shareToken: string): void {
  void getSupabase()
    .rpc("increment_share_view_count", { token: shareToken })
    .then(() => undefined);
}

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const origin = request.headers.get("origin");

  const limit = rateLimit(request, {
    key: "shares:get",
    limit: RATE_LIMIT_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
  });

  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: buildHeaders(origin, rateLimitHeaders(limit, RATE_LIMIT_MAX)),
      }
    );
  }

  try {
    const { token } = await params;

    // Minimal UUID sanity check: prevents wasted DB calls on obviously bad
    // URLs (e.g. /share/foo) and keeps the 404 shape consistent.
    if (!/^[0-9a-f-]{36}$/i.test(token)) {
      return NextResponse.json(
        { error: "Share not found" },
        {
          status: 404,
          headers: buildHeaders(origin, rateLimitHeaders(limit, RATE_LIMIT_MAX)),
        }
      );
    }

    const supabase = getSupabase();

    const { data: share } = await supabase
      .from("shared_conversations")
      .select("share_token, conversation_id, title_snapshot, snapshot_at, created_at, revoked_at")
      .eq("share_token", token)
      .maybeSingle();

    if (!share || (share as DBSharedConversationRow).revoked_at !== null) {
      return NextResponse.json(
        { error: "Share not found" },
        {
          status: 404,
          headers: buildHeaders(origin, rateLimitHeaders(limit, RATE_LIMIT_MAX)),
        }
      );
    }

    const shareRow = share as DBSharedConversationRow;

    // Reported conversations must not be viewable via their share link.
    const { data: conversation } = await supabase
      .from("conversations")
      .select("id, title, created_at, is_reported")
      .eq("id", shareRow.conversation_id)
      .maybeSingle();

    if (!conversation || (conversation as DBConversationRow).is_reported) {
      return NextResponse.json(
        { error: "Share not found" },
        {
          status: 404,
          headers: buildHeaders(origin, rateLimitHeaders(limit, RATE_LIMIT_MAX)),
        }
      );
    }

    const convRow = conversation as DBConversationRow;

    const { data: messages, error: messagesErr } = await supabase
      .from("messages")
      .select("id, conversation_id, role, content, created_at, model_used, extended_data")
      .eq("conversation_id", shareRow.conversation_id)
      .is("sub_conversation_id", null)
      .lte("created_at", shareRow.snapshot_at)
      .order("created_at", { ascending: true });

    if (messagesErr) {
      return NextResponse.json(
        { error: "Failed to load shared conversation" },
        {
          status: 500,
          headers: buildHeaders(origin, rateLimitHeaders(limit, RATE_LIMIT_MAX)),
        }
      );
    }

    const payload: PublicSharePayload = {
      shareToken: shareRow.share_token,
      title: shareRow.title_snapshot ?? convRow.title,
      snapshotAt: shareRow.snapshot_at,
      sharedAt: shareRow.created_at,
      messages: ((messages ?? []) as DBMessageRow[]).map(toPublicMessage),
    };

    recordView(shareRow.share_token);

    return NextResponse.json(payload, {
      headers: buildHeaders(origin, rateLimitHeaders(limit, RATE_LIMIT_MAX)),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      {
        status: 500,
        headers: buildHeaders(origin, rateLimitHeaders(limit, RATE_LIMIT_MAX)),
      }
    );
  }
}
