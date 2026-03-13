import { getSupabase } from "./supabase";
import { randomUUID } from "crypto";

const BUCKET = "generated-images";

interface StoredImage {
  id: string;
  publicUrl: string;
  storagePath: string;
}

/**
 * Upload an image (base64 data URI or raw base64) to Supabase Storage
 * and insert a row into the generated_images table.
 *
 * Returns the public URL that replaces the base64 data URI everywhere.
 */
export async function uploadGeneratedImage(opts: {
  imageDataUrl: string;
  conversationId: string;
  messageId: string;
  prompt: string;
  model: string;
  provider: string;
  size?: string;
  style?: string;
}): Promise<StoredImage> {
  const supabase = getSupabase();
  const id = `img-${Date.now()}-${randomUUID().slice(0, 8)}`;

  // Parse the data URI → raw buffer
  let buffer: Buffer;
  let mimeType = "image/png";

  if (opts.imageDataUrl.startsWith("data:")) {
    const match = opts.imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
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

  const publicUrl = urlData.publicUrl;

  // Insert metadata row
  const { error: dbError } = await supabase.from("generated_images").insert({
    id,
    conversation_id: opts.conversationId,
    message_id: opts.messageId,
    storage_path: storagePath,
    public_url: publicUrl,
    prompt: opts.prompt?.slice(0, 500) || null,
    model: opts.model || null,
    provider: opts.provider || null,
    size: opts.size || null,
    style: opts.style || null,
  });

  if (dbError) {
    // Clean up the uploaded file if DB insert fails
    await supabase.storage.from(BUCKET).remove([storagePath]);
    throw new Error(`Image metadata insert failed: ${dbError.message}`);
  }

  return { id, publicUrl, storagePath };
}

/**
 * Fetch generated images for the gallery. Newest first, with pagination.
 */
export async function fetchGeneratedImages(opts?: {
  limit?: number;
  offset?: number;
  conversationId?: string;
}) {
  const supabase = getSupabase();
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  let query = supabase
    .from("generated_images")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (opts?.conversationId) {
    query = query.eq("conversation_id", opts.conversationId);
  }

  const { data, error, count } = await query;

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
    total: count,
  };
}

/**
 * Delete a generated image by ID (removes from both storage and database).
 */
export async function deleteGeneratedImageById(imageId: string) {
  const supabase = getSupabase();

  // Get the storage path first
  const { data: row, error: fetchError } = await supabase
    .from("generated_images")
    .select("storage_path")
    .eq("id", imageId)
    .single();

  if (fetchError || !row) {
    throw new Error(`Image not found: ${imageId}`);
  }

  // Delete from storage
  await supabase.storage.from(BUCKET).remove([row.storage_path]);

  // Delete from database
  const { error: deleteError } = await supabase
    .from("generated_images")
    .delete()
    .eq("id", imageId);

  if (deleteError) {
    throw new Error(`Failed to delete image: ${deleteError.message}`);
  }
}
