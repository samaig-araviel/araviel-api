import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { authenticateRequest, AuthError } from "@/lib/auth";
import { corsHeaders, handleCorsOptions } from "../cors";

const BUCKET = "avatars";
const MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

export async function OPTIONS(request: NextRequest) {
  return handleCorsOptions(request.headers.get("origin"));
}

/**
 * POST /api/avatar
 * Body: { image: "<data:image/...;base64,...>" }
 * Uploads the user's avatar to Supabase Storage and updates user_settings.
 */
export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");

  let user;
  try {
    user = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status, headers: corsHeaders(origin) }
      );
    }
    throw err;
  }

  try {
    const body = await request.json();
    const { image } = body;

    if (!image || typeof image !== "string") {
      return NextResponse.json(
        { error: "image is required (base64 data URI)" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    // Parse data URI
    let buffer: Buffer;
    let mimeType = "image/png";

    if (image.startsWith("data:")) {
      const match = image.match(/^data:([^;]+);base64,([\s\S]+)$/);
      if (!match) {
        return NextResponse.json(
          { error: "Invalid data URI format" },
          { status: 400, headers: corsHeaders(origin) }
        );
      }
      mimeType = match[1];
      buffer = Buffer.from(match[2], "base64");
    } else {
      // Raw base64
      buffer = Buffer.from(image, "base64");
    }

    // Validate mime type
    const allowedTypes = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
    if (!allowedTypes.includes(mimeType)) {
      return NextResponse.json(
        { error: "Invalid image type. Allowed: PNG, JPEG, WebP" },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    // Validate size
    if (buffer.length > MAX_SIZE_BYTES) {
      return NextResponse.json(
        { error: `Image too large (${(buffer.length / (1024 * 1024)).toFixed(1)}MB). Max 2MB.` },
        { status: 400, headers: corsHeaders(origin) }
      );
    }

    const ext = mimeType.includes("webp")
      ? "webp"
      : mimeType.includes("jpeg") || mimeType.includes("jpg")
        ? "jpg"
        : "png";
    const storagePath = `${user.id}/avatar.${ext}`;

    const supabase = getSupabase();

    // Upload to Supabase Storage (upsert to overwrite previous avatar)
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, buffer, {
        contentType: mimeType,
        upsert: true,
      });

    if (uploadError) {
      return NextResponse.json(
        { error: `Upload failed: ${uploadError.message}` },
        { status: 500, headers: corsHeaders(origin) }
      );
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(BUCKET)
      .getPublicUrl(storagePath);

    const avatarUrl = urlData.publicUrl;

    // Update user_settings with the new avatar URL
    await supabase
      .from("user_settings")
      .upsert(
        { user_id: user.id, avatar_url: avatarUrl },
        { onConflict: "user_id" }
      );

    return NextResponse.json({ avatarUrl }, { headers: corsHeaders(origin) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to upload avatar" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}

/**
 * DELETE /api/avatar
 * Removes the user's avatar from storage and clears the URL in settings.
 */
export async function DELETE(request: NextRequest) {
  const origin = request.headers.get("origin");

  let user;
  try {
    user = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status, headers: corsHeaders(origin) }
      );
    }
    throw err;
  }

  try {
    const supabase = getSupabase();

    // List and remove all files in the user's avatar folder
    const { data: files } = await supabase.storage
      .from(BUCKET)
      .list(user.id);

    if (files && files.length > 0) {
      const paths = files.map((f) => `${user.id}/${f.name}`);
      await supabase.storage.from(BUCKET).remove(paths);
    }

    // Clear avatar_url in settings
    await supabase
      .from("user_settings")
      .upsert(
        { user_id: user.id, avatar_url: "" },
        { onConflict: "user_id" }
      );

    return NextResponse.json({ success: true }, { headers: corsHeaders(origin) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete avatar" },
      { status: 500, headers: corsHeaders(origin) }
    );
  }
}
