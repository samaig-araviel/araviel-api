import { NextRequest, NextResponse } from "next/server";
import { authenticateRequest, AuthError } from "@/lib/auth";
import type { AuthenticatedUser } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../../../cors";
import { getMessages } from "@/lib/imported-conversations";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

/**
 * GET /api/imported-conversations/:id/messages — Get decrypted messages
 */
export async function GET(
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
    const messages = await getMessages(id, user.id);

    return NextResponse.json({ messages }, { headers: corsHeaders(origin) });
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
