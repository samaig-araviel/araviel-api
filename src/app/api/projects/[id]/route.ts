import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../../cors";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

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

    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.instructions !== undefined) updates.instructions = body.instructions;
    if (body.is_archived !== undefined) updates.is_archived = body.is_archived;
    if (body.is_starred !== undefined) updates.is_starred = body.is_starred;

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("projects")
      .update(updates)
      .eq("id", id)
      .eq("user_id", user.id)
      .select()
      .single();

    if (error) {
      const status = error.code === "PGRST116" ? 404 : 500;
      return NextResponse.json(
        { error: status === 404 ? "Project not found" : error.message },
        { status, headers: corsHeaders(origin) }
      );
    }

    return NextResponse.json(
      { project: data },
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

    // Verify project ownership
    const { data: owned, error: ownErr } = await supabase
      .from("projects")
      .select("id")
      .eq("id", id)
      .eq("user_id", user.id)
      .single();

    if (ownErr || !owned) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404, headers: corsHeaders(origin) }
      );
    }
    const deleteConversations =
      request.nextUrl.searchParams.get("deleteConversations") === "true";

    if (deleteConversations) {
      // Get all conversation IDs for this project
      const { data: convRows, error: fetchError } = await supabase
        .from("conversations")
        .select("id")
        .eq("project_id", id);

      if (fetchError) {
        return NextResponse.json(
          { error: fetchError.message },
          { status: 500, headers: corsHeaders(origin) }
        );
      }

      const convIds = (convRows || []).map((c: { id: string }) => c.id);

      if (convIds.length > 0) {
        // Find sub-conversations for these conversations
        const { data: subConvRows } = await supabase
          .from("sub_conversations")
          .select("id")
          .in("conversation_id", convIds);

        const subConvIds = (subConvRows || []).map(
          (s: { id: string }) => s.id
        );

        // Delete sub-conversation messages if any exist
        if (subConvIds.length > 0) {
          const { error: subMsgErr } = await supabase
            .from("messages")
            .delete()
            .in("sub_conversation_id", subConvIds);

          if (subMsgErr) {
            return NextResponse.json(
              { error: subMsgErr.message },
              { status: 500, headers: corsHeaders(origin) }
            );
          }

          // Delete sub-conversations
          const { error: subConvErr } = await supabase
            .from("sub_conversations")
            .delete()
            .in("id", subConvIds);

          if (subConvErr) {
            return NextResponse.json(
              { error: subConvErr.message },
              { status: 500, headers: corsHeaders(origin) }
            );
          }
        }

        // Delete all messages for these conversations
        const { error: msgErr } = await supabase
          .from("messages")
          .delete()
          .in("conversation_id", convIds);

        if (msgErr) {
          return NextResponse.json(
            { error: msgErr.message },
            { status: 500, headers: corsHeaders(origin) }
          );
        }

        // Delete the conversations
        const { error: convErr } = await supabase
          .from("conversations")
          .delete()
          .in("id", convIds);

        if (convErr) {
          return NextResponse.json(
            { error: convErr.message },
            { status: 500, headers: corsHeaders(origin) }
          );
        }
      }
    } else {
      // Unlink conversations referencing this project
      const { error: unlinkError } = await supabase
        .from("conversations")
        .update({ project_id: null })
        .eq("project_id", id);

      if (unlinkError) {
        return NextResponse.json(
          { error: unlinkError.message },
          { status: 500, headers: corsHeaders(origin) }
        );
      }
    }

    // Delete the project
    const { error } = await supabase
      .from("projects")
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
