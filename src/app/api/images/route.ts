import { NextRequest, NextResponse } from "next/server";
import { fetchGeneratedImages, deleteGeneratedImageById } from "@/lib/image-storage";
import { corsHeaders, handleCorsOptions } from "../cors";

export const runtime = "nodejs";

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

/**
 * GET /api/images — Fetch generated images for the gallery.
 * Query params: limit, offset, conversationId (all optional).
 */
export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");
  const { searchParams } = new URL(request.url);

  const limit = parseInt(searchParams.get("limit") || "50", 10);
  const offset = parseInt(searchParams.get("offset") || "0", 10);
  const conversationId = searchParams.get("conversationId") || undefined;

  try {
    const result = await fetchGeneratedImages({ limit, offset, conversationId });
    return NextResponse.json(result, { headers: corsHeaders(origin) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch images" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}

/**
 * DELETE /api/images — Delete a generated image by ID.
 * Body: { id: string }
 */
export async function DELETE(request: NextRequest) {
  const origin = request.headers.get("origin");

  try {
    const body = await request.json();
    const imageId = body?.id;

    if (!imageId || typeof imageId !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid image ID" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    await deleteGeneratedImageById(imageId);
    return NextResponse.json({ success: true }, { headers: corsHeaders(origin) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete image" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
