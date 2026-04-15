import { NextRequest, NextResponse } from "next/server";
import { cleanupExpiredGuestData } from "@/lib/guest-cleanup";
import { requestContext, withRequestId } from "@/lib/request-context";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const ctx = requestContext(request, "cron.cleanup-guest-data");
  const authHeader = request.headers.get("authorization");

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    ctx.log.warn("Unauthorized cron invocation");
    return NextResponse.json(
      { error: "Unauthorized", requestId: ctx.requestId },
      { status: 401, headers: withRequestId({}, ctx.requestId) }
    );
  }

  try {
    const result = await cleanupExpiredGuestData();
    return NextResponse.json(
      {
        success: true,
        ...result,
      },
      { headers: withRequestId({}, ctx.requestId) }
    );
  } catch (err) {
    ctx.log.error("Guest cleanup failed", err);
    return NextResponse.json(
      {
        error: "Internal server error",
        requestId: ctx.requestId,
      },
      { status: 500, headers: withRequestId({}, ctx.requestId) }
    );
  }
}
