import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, handleCorsOptions } from "../cors";
import {
  bulkImport,
  getUserId,
  listConversations,
  validateConversationInput,
  type ImportConversationInput,
} from "@/lib/imported-conversations";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

/**
 * POST /api/imported-conversations — Bulk import conversations
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");

  try {
    const userId = getUserId(request);

    const body = await request.json().catch(() => null);
    if (!body || !Array.isArray(body.conversations) || body.conversations.length === 0) {
      return NextResponse.json(
        { error: "conversations must be a non-empty array" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    // Validate each conversation input — skip invalid ones instead of
    // rejecting the whole batch so partial imports still succeed.
    const conversations: ImportConversationInput[] = [];
    for (let i = 0; i < body.conversations.length; i++) {
      const err = validateConversationInput(body.conversations[i], i);
      if (err) {
        continue; // skip this conversation
      }
      const c = body.conversations[i] as Record<string, unknown>;
      conversations.push({
        externalId: c.externalId as string | undefined,
        title: c.title as string,
        provider: c.provider as string,
        providerName: c.providerName as string,
        messages: c.messages as ImportConversationInput["messages"],
        messageCount: c.messageCount as number,
        createdAt: c.createdAt as string | undefined,
        updatedAt: c.updatedAt as string | undefined,
      });
    }

    if (conversations.length === 0) {
      return NextResponse.json(
        { error: "No valid conversations found in the request" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    const result = await bulkImport(userId, conversations);

    return NextResponse.json(result, {
      status: 201,
      headers: corsHeaders(origin),
    });
  } catch (err) {
    console.error("[POST /api/imported-conversations]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}

/**
 * GET /api/imported-conversations — List imported conversations
 */
export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");

  try {
    const userId = getUserId(request);

    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") || undefined;
    const archivedParam = searchParams.get("archived");
    const starredParam = searchParams.get("starred");

    const archived = archivedParam === "true";
    const starred =
      starredParam === "true" ? true : starredParam === "false" ? false : undefined;

    const conversations = await listConversations(userId, {
      provider,
      archived,
      starred,
    });

    return NextResponse.json(
      { conversations },
      { headers: corsHeaders(origin) }
    );
  } catch (err) {
    console.error("[GET /api/imported-conversations]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
