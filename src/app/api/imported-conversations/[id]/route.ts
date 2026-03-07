import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, handleCorsOptions } from "../../cors";
import { updateConversation, softDelete } from "@/lib/imported-conversations";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

/**
 * PATCH /api/imported-conversations/:id — Update conversation metadata
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const origin = request.headers.get("origin");

  try {
    const userId = request.headers.get("x-user-id");
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401, headers: corsHeaders(origin) }
      );
    }

    const { id } = await params;
    const body = await request.json().catch(() => null);

    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Request body is required" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    const updates: { title?: string; isStarred?: boolean; isArchived?: boolean } = {};

    if (body.title !== undefined) updates.title = body.title;
    if (body.isStarred !== undefined) updates.isStarred = body.isStarred;
    if (body.isArchived !== undefined) updates.isArchived = body.isArchived;

    const conversation = await updateConversation(userId, id, updates);

    return NextResponse.json(conversation, {
      headers: corsHeaders(origin),
    });
  } catch (err) {
    const statusCode =
      err instanceof Error && "statusCode" in err
        ? (err as Error & { statusCode: number }).statusCode
        : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: statusCode, headers: corsHeaders(origin) }
    );
  }
}

/**
 * DELETE /api/imported-conversations/:id — Soft delete one conversation
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const origin = request.headers.get("origin");

  try {
    const userId = request.headers.get("x-user-id");
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401, headers: corsHeaders(origin) }
      );
    }

    const { id } = await params;
    await softDelete(userId, id);

    return NextResponse.json(
      { success: true },
      { headers: corsHeaders(origin) }
    );
  } catch (err) {
    const statusCode =
      err instanceof Error && "statusCode" in err
        ? (err as Error & { statusCode: number }).statusCode
        : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: statusCode, headers: corsHeaders(origin) }
    );
  }
}
