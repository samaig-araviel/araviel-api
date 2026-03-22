import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSupabase } from "@/lib/supabase";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../cors";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

export async function GET(request: NextRequest) {
  let user: AuthenticatedUser;
  try {
    user = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: corsHeaders(request.headers.get("origin")) });
    }
    throw err;
  }

  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "20", 10), 100);
    const offset = parseInt(searchParams.get("offset") ?? "0", 10);

    const projectId = searchParams.get("projectId");
    const starredParam = searchParams.get("starred");
    const archivedParam = searchParams.get("archived");
    const search = searchParams.get("search");

    const supabase = getSupabase();

    let dataQuery = supabase
      .from("conversations")
      .select("id, title, created_at, updated_at, project_id, is_starred, is_archived, is_reported")
      .eq("user_id", user.id)
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);

    let countQuery = supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);

    if (projectId) {
      dataQuery = dataQuery.eq("project_id", projectId);
      countQuery = countQuery.eq("project_id", projectId);
    }

    if (starredParam !== null) {
      const isStarred = starredParam === "true";
      dataQuery = dataQuery.eq("is_starred", isStarred);
      countQuery = countQuery.eq("is_starred", isStarred);
    }

    if (archivedParam !== null) {
      const isArchived = archivedParam === "true";
      dataQuery = dataQuery.eq("is_archived", isArchived);
      countQuery = countQuery.eq("is_archived", isArchived);
    }

    if (search) {
      dataQuery = dataQuery.ilike("title", `%${search}%`);
      countQuery = countQuery.ilike("title", `%${search}%`);
    }

    const [{ data, error }, { count, error: countError }] = await Promise.all([
      dataQuery,
      countQuery,
    ]);

    if (error || countError) {
      return NextResponse.json(
        { error: (error ?? countError)?.message },
        { status: 500, headers: corsHeaders(request.headers.get("origin")) }
      );
    }

    const conversations = (data ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      projectId: c.project_id ?? null,
      isStarred: c.is_starred ?? false,
      isArchived: c.is_archived ?? false,
      isReported: c.is_reported ?? false,
    }));

    return NextResponse.json(
      { conversations, total: count ?? 0 },
      { headers: corsHeaders(request.headers.get("origin")) }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(request.headers.get("origin")) }
    );
  }
}

export async function POST(request: NextRequest) {
  let user: AuthenticatedUser;
  try {
    user = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status, headers: corsHeaders(request.headers.get("origin")) });
    }
    throw err;
  }

  try {
    const body = await request.json().catch(() => ({}));
    const title = typeof body.title === "string" && body.title.trim()
      ? body.title.trim()
      : "New conversation";

    const supabase = getSupabase();
    const id = randomUUID();
    const now = new Date().toISOString();

    const { error } = await supabase.from("conversations").insert({
      id,
      title,
      user_id: user.id,
      created_at: now,
      updated_at: now,
    });

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: corsHeaders(request.headers.get("origin")) }
      );
    }

    return NextResponse.json(
      { id, title, createdAt: now, updatedAt: now },
      { status: 201, headers: corsHeaders(request.headers.get("origin")) }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(request.headers.get("origin")) }
    );
  }
}
