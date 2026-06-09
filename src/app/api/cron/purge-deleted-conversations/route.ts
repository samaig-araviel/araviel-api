import { NextRequest, NextResponse } from "next/server";
import { purgeExpiredTrashedConversations } from "@/lib/trash-purge";
import { requestContext, withRequestId } from "@/lib/request-context";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const ctx = requestContext(request, "cron.purge-deleted-conversations");
  const authHeader = request.headers.get("authorization");

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    ctx.log.warn("Unauthorized cron invocation");
    return NextResponse.json(
      { error: "Unauthorized", requestId: ctx.requestId },
      { status: 401, headers: withRequestId({}, ctx.requestId) }
    );
  }

  try {
    const result = await purgeExpiredTrashedConversations();
    return NextResponse.json(
      { success: true, ...result },
      { headers: withRequestId({}, ctx.requestId) }
    );
  } catch (err) {
    ctx.log.error("Trash purge failed", err);
    return NextResponse.json(
      { error: "Internal server error", requestId: ctx.requestId },
      { status: 500, headers: withRequestId({}, ctx.requestId) }
    );
  }
}
