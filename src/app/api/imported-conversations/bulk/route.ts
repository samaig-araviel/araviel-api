import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
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

    const updated = await bulkUpdate(body.ids, updates, user.id);

    return NextResponse.json({ updated }, { headers: corsHeaders(origin) });
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
    const body = await request.json().catch(() => null);

    if (!body || !Array.isArray(body.ids) || body.ids.length === 0) {
      return NextResponse.json(
        { error: "ids must be a non-empty array" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    const deleted = await bulkSoftDelete(body.ids, user.id);

    return NextResponse.json({ deleted }, { headers: corsHeaders(origin) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
