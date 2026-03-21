import { getSupabase } from "./supabase";

const STORAGE_BUCKET = "generated-images";
const CHUNK_SIZE = 500;
const USER_BATCH_SIZE = 10;

export interface CleanupResult {
  usersProcessed: number;
  usersDeleted: number;
  conversationsDeleted: number;
  messagesDeleted: number;
  imagesDeleted: number;
  storageFilesDeleted: number;
  errors: Array<{ userId: string; error: string }>;
  durationMs: number;
}

/**
 * Delete all data for anonymous/guest users whose accounts were created
 * more than `cutoffHours` ago. This includes conversations, messages,
 * sub-conversations, logs, images (DB + Storage), credits, and settings.
 * Finally removes the anonymous auth.users entry itself.
 *
 * Designed to be idempotent — safe to re-run; partial failures are logged
 * and retried on the next invocation.
 */
export async function cleanupExpiredGuestData(
  cutoffHours = 24
): Promise<CleanupResult> {
  const start = Date.now();
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - cutoffHours * 60 * 60 * 1000).toISOString();

  const result: CleanupResult = {
    usersProcessed: 0,
    usersDeleted: 0,
    conversationsDeleted: 0,
    messagesDeleted: 0,
    imagesDeleted: 0,
    storageFilesDeleted: 0,
    errors: [],
    durationMs: 0,
  };

  // ── Step 1: Collect anonymous user IDs older than the cutoff ──────────
  const anonUserIds: string[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const {
      data: { users },
      error,
    } = await supabase.auth.admin.listUsers({ page, perPage });

    if (error) {
      console.error("[guest-cleanup] Failed to list users:", error.message);
      break;
    }

    for (const u of users) {
      if (u.is_anonymous && u.created_at && u.created_at < cutoff) {
        anonUserIds.push(u.id);
      }
    }

    if (users.length < perPage) break;
    page++;
  }

  if (anonUserIds.length === 0) {
    console.log("[guest-cleanup] No expired anonymous users found.");
    result.durationMs = Date.now() - start;
    return result;
  }

  console.log(`[guest-cleanup] Found ${anonUserIds.length} expired anonymous user(s).`);

  // ── Step 2: Process users in batches ──────────────────────────────────
  for (let i = 0; i < anonUserIds.length; i += USER_BATCH_SIZE) {
    const batch = anonUserIds.slice(i, i + USER_BATCH_SIZE);

    for (const userId of batch) {
      try {
        const counts = await deleteAllUserData(supabase, userId);
        result.conversationsDeleted += counts.conversations;
        result.messagesDeleted += counts.messages;
        result.imagesDeleted += counts.images;
        result.storageFilesDeleted += counts.storageFiles;

        // Remove the anonymous auth entry last
        const { error: deleteUserErr } = await supabase.auth.admin.deleteUser(userId);
        if (deleteUserErr) {
          console.error(`[guest-cleanup] Failed to delete auth user ${userId}:`, deleteUserErr.message);
          result.errors.push({ userId, error: `auth delete: ${deleteUserErr.message}` });
        } else {
          result.usersDeleted++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[guest-cleanup] Error cleaning up user ${userId}:`, msg);
        result.errors.push({ userId, error: msg });
      }

      result.usersProcessed++;
    }
  }

  result.durationMs = Date.now() - start;
  console.log(
    `[guest-cleanup] Done. ` +
    `Users: ${result.usersDeleted}/${result.usersProcessed}, ` +
    `Conversations: ${result.conversationsDeleted}, ` +
    `Messages: ${result.messagesDeleted}, ` +
    `Images: ${result.imagesDeleted} (${result.storageFilesDeleted} files), ` +
    `Errors: ${result.errors.length}, ` +
    `Duration: ${result.durationMs}ms`
  );

  return result;
}

// ── Internal helpers ──────────────────────────────────────────────────────

interface DeletionCounts {
  conversations: number;
  messages: number;
  images: number;
  storageFiles: number;
}

/**
 * Cascade-delete all data for a single user, following FK constraints.
 */
async function deleteAllUserData(
  supabase: ReturnType<typeof getSupabase>,
  userId: string
): Promise<DeletionCounts> {
  const counts: DeletionCounts = { conversations: 0, messages: 0, images: 0, storageFiles: 0 };

  // ── Conversations & dependent rows ────────────────────────────────────

  // Get all conversation IDs for this user
  const { data: convRows } = await supabase
    .from("conversations")
    .select("id")
    .eq("user_id", userId);

  const convIds = (convRows || []).map((r: { id: string }) => r.id);

  if (convIds.length > 0) {
    // Get sub-conversation IDs
    const subIds = await getIds(supabase, "sub_conversations", "id", "conversation_id", convIds);

    if (subIds.length > 0) {
      // Delete messages belonging to sub-conversations
      await chunkedDelete(supabase, "messages", "sub_conversation_id", subIds);
      // Delete sub-conversation reports
      await chunkedDelete(supabase, "sub_conversation_reports", "sub_conversation_id", subIds);
      // Delete sub-conversations
      await chunkedDelete(supabase, "sub_conversations", "id", subIds);
    }

    // Get all message IDs for these conversations (main conversation messages)
    const msgIds = await getIds(supabase, "messages", "id", "conversation_id", convIds);

    if (msgIds.length > 0) {
      // Delete logs and feedback tied to messages
      await chunkedDelete(supabase, "routing_logs", "message_id", msgIds);
      await chunkedDelete(supabase, "api_call_logs", "message_id", msgIds);
      await chunkedDelete(supabase, "message_feedback", "message_id", msgIds);
      counts.messages = msgIds.length;
    }

    // Delete messages
    await chunkedDelete(supabase, "messages", "conversation_id", convIds);

    // Delete conversation reports
    await chunkedDelete(supabase, "conversation_reports", "conversation_id", convIds);

    // Delete conversations
    await chunkedDelete(supabase, "conversations", "id", convIds);
    counts.conversations = convIds.length;
  }

  // ── Generated images (DB + Storage) ───────────────────────────────────

  const { data: imageRows } = await supabase
    .from("generated_images")
    .select("id, storage_path")
    .eq("user_id", userId);

  if (imageRows && imageRows.length > 0) {
    // Delete files from Storage bucket
    const paths = imageRows
      .map((r: { storage_path: string }) => r.storage_path)
      .filter(Boolean);

    if (paths.length > 0) {
      for (let j = 0; j < paths.length; j += CHUNK_SIZE) {
        const pathChunk = paths.slice(j, j + CHUNK_SIZE);
        const { error: storageErr } = await supabase.storage
          .from(STORAGE_BUCKET)
          .remove(pathChunk);
        if (storageErr) {
          console.error(`[guest-cleanup] Storage delete error for user ${userId}:`, storageErr.message);
        } else {
          counts.storageFiles += pathChunk.length;
        }
      }
    }

    // Delete DB rows
    await supabase.from("generated_images").delete().eq("user_id", userId);
    counts.images = imageRows.length;
  }

  // ── Ancillary user data ───────────────────────────────────────────────

  await supabase.from("credit_usage_log").delete().eq("user_id", userId);
  await supabase.from("credit_accounts").delete().eq("user_id", userId);
  await supabase.from("user_settings").delete().eq("user_id", userId);

  return counts;
}

/**
 * Fetch IDs from a table where a column matches any of the given values.
 * Handles chunking for large arrays.
 */
async function getIds(
  supabase: ReturnType<typeof getSupabase>,
  table: string,
  selectColumn: string,
  filterColumn: string,
  filterValues: string[]
): Promise<string[]> {
  const ids: string[] = [];

  for (let i = 0; i < filterValues.length; i += CHUNK_SIZE) {
    const chunk = filterValues.slice(i, i + CHUNK_SIZE);
    const { data } = await supabase
      .from(table)
      .select(selectColumn)
      .in(filterColumn, chunk);

    if (data) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ids.push(...data.map((r: any) => r[selectColumn]));
    }
  }

  return ids;
}

/**
 * Delete rows from a table in chunks to avoid PostgREST URL-length limits.
 */
async function chunkedDelete(
  supabase: ReturnType<typeof getSupabase>,
  table: string,
  column: string,
  ids: string[]
): Promise<void> {
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const { error } = await supabase.from(table).delete().in(column, chunk);
    if (error) {
      console.error(`[guest-cleanup] Failed to delete from ${table}.${column}:`, error.message);
    }
  }
}
