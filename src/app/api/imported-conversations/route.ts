import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, handleCorsOptions } from "../cors";
import {
  bulkImport,
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
    const userId = request.headers.get("x-user-id");
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401, headers: corsHeaders(origin) }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body || !Array.isArray(body.conversations) || body.conversations.length === 0) {
      return NextResponse.json(
        { error: "conversations must be a non-empty array" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    // Validate each conversation input
    for (let i = 0; i < body.conversations.length; i++) {
      const err = validateConversationInput(body.conversations[i], i);
      if (err) {
        return NextResponse.json(
          { error: err },
          { status: 400, headers: corsHeaders(origin) }
        );
      }
    }

    const conversations: ImportConversationInput[] = body.conversations.map(
      (c: Record<string, unknown>) => ({
        externalId: c.externalId as string | undefined,
        title: c.title as string,
        provider: c.provider as string,
        providerName: c.providerName as string,
        messages: c.messages as ImportConversationInput["messages"],
        messageCount: c.messageCount as number,
        createdAt: c.createdAt as string | undefined,
        updatedAt: c.updatedAt as string | undefined,
      })
    );

    const result = await bulkImport(userId, conversations);

    return NextResponse.json(result, {
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
 * GET /api/imported-conversations — List imported conversations
 */
export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");

  try {
    const userId = request.headers.get("x-user-id");
    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401, headers: corsHeaders(origin) }
      );
    }

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
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
