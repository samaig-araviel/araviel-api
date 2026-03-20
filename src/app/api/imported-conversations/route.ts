import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../cors";
import {
  bulkImport,
  listConversations,
  validateConversationInput,
  type ImportConversationInput,
} from "@/lib/imported-conversations";
import {
  isClaudeExportFormat,
  transformClaudeExport,
} from "@/lib/claude-export-transform";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

/**
 * POST /api/imported-conversations — Bulk import conversations
 */
export async function POST(request: NextRequest) {
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
    const raw = await request.json().catch(() => null);
    const body = isClaudeExportFormat(raw) ? transformClaudeExport(raw) : raw;

    if (
      !body ||
      !Array.isArray(body.conversations) ||
      body.conversations.length === 0
    ) {
      return NextResponse.json(
        { error: "conversations must be a non-empty array" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    // Validate each conversation — skip invalid ones so partial imports succeed
    const conversations: ImportConversationInput[] = [];
    for (let i = 0; i < body.conversations.length; i++) {
      const err = validateConversationInput(body.conversations[i], i);
      if (err) {
        continue;
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

    const result = await bulkImport(conversations, user.id);

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
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") || undefined;
    const archivedParam = searchParams.get("archived");
    const starredParam = searchParams.get("starred");

    const archived = archivedParam === "true";
    const starred =
      starredParam === "true"
        ? true
        : starredParam === "false"
          ? false
          : undefined;

    const conversations = await listConversations({
      provider,
      archived,
      starred,
      userId: user.id,
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
