import { NextRequest, NextResponse } from "next/server";
import { cleanupExpiredGuestData } from "@/lib/guest-cleanup";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await cleanupExpiredGuestData();

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error("[cron/cleanup-guest-data] Unexpected error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
