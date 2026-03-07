import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, handleCorsOptions } from "../../cors";
import { bulkUpdate, bulkSoftDelete } from "@/lib/imported-conversations";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

/**
 * PATCH /api/imported-conversations/bulk — Bulk update (star/archive/unarchive)
 */
export async function PATCH(request: NextRequest) {
  const origin = request.headers.get("origin");

  try {
    const userId = request.headers.get("x-user-id");
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401, headers: corsHeaders(origin) }
      );
    }

    const body = await request.json().catch(() => null);

    if (!body || !Array.isArray(body.ids) || body.ids.length === 0) {
      return NextResponse.json(
        { error: "ids must be a non-empty array" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    if (!body.updates || typeof body.updates !== "object") {
      return NextResponse.json(
        { error: "updates object is required" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    const updates: { isStarred?: boolean; isArchived?: boolean } = {};
    if (body.updates.isStarred !== undefined) {
      updates.isStarred = body.updates.isStarred;
    }
    if (body.updates.isArchived !== undefined) {
      updates.isArchived = body.updates.isArchived;
    }

    const updated = await bulkUpdate(userId, body.ids, updates);

    return NextResponse.json(
      { updated },
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
 * DELETE /api/imported-conversations/bulk — Bulk soft delete
 */
export async function DELETE(request: NextRequest) {
  const origin = request.headers.get("origin");

  try {
    const userId = request.headers.get("x-user-id");
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401, headers: corsHeaders(origin) }
      );
    }

    const body = await request.json().catch(() => null);

    if (!body || !Array.isArray(body.ids) || body.ids.length === 0) {
      return NextResponse.json(
        { error: "ids must be a non-empty array" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    const deleted = await bulkSoftDelete(userId, body.ids);

    return NextResponse.json(
      { deleted },
      { headers: corsHeaders(origin) }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
