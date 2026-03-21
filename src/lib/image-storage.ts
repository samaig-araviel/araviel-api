import { getSupabase } from "./supabase";
import { randomUUID } from "crypto";

const BUCKET = "generated-images";

interface UploadResult {
  id: string;
  publicUrl: string;
  storagePath: string;
}

interface ImageMetadata {
  id: string;
  userId: string;
  storagePath: string;
  publicUrl: string;
  conversationId: string;
  messageId: string;
  prompt: string;
  model: string;
  provider: string;
  size?: string;
  style?: string;
}

/**
 * Upload an image to Supabase Storage only (no database row).
 * Call saveImageMetadata() separately after the message row exists in the DB.
 */
export async function uploadImageToStorage(opts: {
  imageDataUrl: string;
  conversationId: string;
}): Promise<UploadResult> {
  const supabase = getSupabase();
  const id = `img-${Date.now()}-${randomUUID().slice(0, 8)}`;

  // Parse the data URI → raw buffer
  let buffer: Buffer;
  let mimeType = "image/png";

  if (opts.imageDataUrl.startsWith("data:")) {
    const match = opts.imageDataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
    if (!match) throw new Error("Invalid image data URI");
    mimeType = match[1];
    buffer = Buffer.from(match[2], "base64");
  } else if (opts.imageDataUrl.startsWith("http")) {
    // External URL (e.g. DALL-E 3) — fetch and upload
    const res = await fetch(opts.imageDataUrl);
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
    const arrayBuf = await res.arrayBuffer();
    buffer = Buffer.from(arrayBuf);
    mimeType = res.headers.get("content-type") || "image/png";
  } else {
    // Raw base64 string
    buffer = Buffer.from(opts.imageDataUrl, "base64");
  }

  // Check size — Supabase bucket limit is 10MB
  const sizeMB = buffer.length / (1024 * 1024);
  if (sizeMB > 10) {
    throw new Error(`Image too large (${sizeMB.toFixed(1)}MB) — max 10MB`);
  }

  const ext = mimeType.includes("webp") ? "webp" : mimeType.includes("jpeg") ? "jpg" : "png";
  const storagePath = `${opts.conversationId}/${id}.${ext}`;

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      contentType: mimeType,
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`Storage upload failed: ${uploadError.message}`);
  }

  // Get the public URL
  const { data: urlData } = supabase.storage
    .from(BUCKET)
    .getPublicUrl(storagePath);

  return { id, publicUrl: urlData.publicUrl, storagePath };
}

/**
 * Insert the image metadata row into the generated_images table.
 * Must be called AFTER the message row exists (to satisfy FK on message_id).
 */
export async function saveImageMetadata(meta: ImageMetadata): Promise<void> {
  const supabase = getSupabase();

  const { error: dbError } = await supabase.from("generated_images").insert({
    id: meta.id,
    user_id: meta.userId,
    conversation_id: meta.conversationId,
    message_id: meta.messageId,
    storage_path: meta.storagePath,
    public_url: meta.publicUrl,
    prompt: meta.prompt?.slice(0, 500) || null,
    model: meta.model || null,
    provider: meta.provider || null,
    size: meta.size || null,
    style: meta.style || null,
  });

  if (dbError) {
    console.error("[image-storage] Failed to save image metadata:", dbError.message);
    // Don't throw — the image is already in Storage and usable.
    // The metadata row can be backfilled later if needed.
  }
}

/**
 * Fetch generated images for the gallery. Newest first, with pagination.
 */
export async function fetchGeneratedImages(opts: {
  userId: string;
  limit?: number;
  offset?: number;
  conversationId?: string;
}) {
  const supabase = getSupabase();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  let query = supabase
    .from("generated_images")
    .select("*")
    .eq("user_id", opts.userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (opts.conversationId) {
    query = query.eq("conversation_id", opts.conversationId);
  }

  const { data, error } = await query;

  if (error) throw new Error(`Failed to fetch images: ${error.message}`);

  return {
    images: (data || []).map((row: Record<string, unknown>) => ({
      id: row.id,
      url: row.public_url,
      prompt: row.prompt,
      model: row.model,
      provider: row.provider,
      size: row.size,
      style: row.style,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      createdAt: row.created_at,
    })),
  };
}

/**
 * Delete a generated image by ID (removes from both storage and database).
 */
export async function deleteGeneratedImageById(imageId: string, userId: string) {
  const supabase = getSupabase();

  // Get the storage path first — scoped to the owning user
  const { data: row, error: fetchError } = await supabase
    .from("generated_images")
    .select("storage_path")
    .eq("id", imageId)
    .eq("user_id", userId)
    .single();

  if (fetchError || !row) {
    throw new Error(`Image not found: ${imageId}`);
  }

  // Delete from storage
  await supabase.storage.from(BUCKET).remove([row.storage_path]);

  // Delete from database — scoped to the owning user
  const { error: deleteError } = await supabase
    .from("generated_images")
    .delete()
    .eq("id", imageId)
    .eq("user_id", userId);

  if (deleteError) {
    throw new Error(`Failed to delete image: ${deleteError.message}`);
  }
}
