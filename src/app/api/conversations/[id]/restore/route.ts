import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { getTrashCutoffIso } from "@/lib/conversation-trash";
import { corsHeaders, handleCorsOptions } from "../../../cors";

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
    const { id } = await params;
    const supabase = getSupabase();
    const cutoffIso = getTrashCutoffIso();

    const { data, error } = await supabase
      .from("conversations")
      .update({ deleted_at: null })
      .eq("id", id)
      .eq("user_id", user.id)
      .not("deleted_at", "is", null)
      .gte("deleted_at", cutoffIso)
      .select("id, title, created_at, updated_at, project_id, is_starred, is_archived, is_reported")
      .single();

    if (error || !data) {
      return NextResponse.json(
        { error: "Conversation not found or grace period expired" },
        { status: 404, headers: corsHeaders(origin) }
      );
    }

    return NextResponse.json(
      {
        id: data.id,
        title: data.title,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        projectId: data.project_id ?? null,
        isStarred: data.is_starred ?? false,
        isArchived: data.is_archived ?? false,
        isReported: data.is_reported ?? false,
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
