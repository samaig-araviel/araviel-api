import { NextRequest, NextResponse } from "next/server";
import { runStatusCheck } from "@/lib/status-monitor";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runStatusCheck();

    return NextResponse.json({
      success: true,
      overall: result.overall,
      providers: result.providers.length,
      platform: result.platform.length,
      timestamp: result.timestamp,
    });
  } catch (err) {
    console.error("[cron/status-check] Unexpected error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
