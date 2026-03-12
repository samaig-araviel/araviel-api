import { NextRequest, NextResponse } from "next/server";
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

  try {
    const { id } = await params;
    const messages = await getMessages(id);

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
