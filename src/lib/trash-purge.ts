import { getSupabase } from "./supabase";
import { logger } from "./logger";
import { getTrashCutoffIso } from "./conversation-trash";

const log = logger.child({ module: "trash-purge" });
const CHUNK_SIZE = 500;

export interface PurgeResult {
  conversationsPurged: number;
  messagesPurged: number;
  subConversationsPurged: number;
  durationMs: number;
}

export async function purgeExpiredTrashedConversations(): Promise<PurgeResult> {
  const start = Date.now();
  const supabase = getSupabase();
  const cutoffIso = getTrashCutoffIso();

  const result: PurgeResult = {
    conversationsPurged: 0,
    messagesPurged: 0,
    subConversationsPurged: 0,
    durationMs: 0,
  };

  const { data: convRows, error: convErr } = await supabase
    .from("conversations")
    .select("id")
    .lt("deleted_at", cutoffIso)
    .not("deleted_at", "is", null);

  if (convErr) {
    log.error("Failed to fetch expired trashed conversations", convErr);
    throw convErr;
  }

  const convIds = (convRows ?? []).map((r: { id: string }) => r.id);
  if (convIds.length === 0) {
    result.durationMs = Date.now() - start;
    log.info("No expired trashed conversations to purge");
    return result;
  }

  const subIds = await collectIds(supabase, "sub_conversations", "id", "conversation_id", convIds);
  if (subIds.length > 0) {
    await chunkedDelete(supabase, "messages", "sub_conversation_id", subIds);
    await chunkedDelete(supabase, "sub_conversation_reports", "sub_conversation_id", subIds);
    await chunkedDelete(supabase, "sub_conversations", "id", subIds);
    result.subConversationsPurged = subIds.length;
  }

  const msgIds = await collectIds(supabase, "messages", "id", "conversation_id", convIds);
  if (msgIds.length > 0) {
    await chunkedDelete(supabase, "routing_logs", "message_id", msgIds);
    await chunkedDelete(supabase, "api_call_logs", "message_id", msgIds);
    await chunkedDelete(supabase, "message_feedback", "message_id", msgIds);
    result.messagesPurged = msgIds.length;
  }

  await chunkedDelete(supabase, "messages", "conversation_id", convIds);
  await chunkedDelete(supabase, "conversation_reports", "conversation_id", convIds);
  await chunkedDelete(supabase, "shared_conversations", "conversation_id", convIds);
  await chunkedDelete(supabase, "conversations", "id", convIds);
  result.conversationsPurged = convIds.length;

  result.durationMs = Date.now() - start;
  log.info("Trash purge complete", { ...result });
  return result;
}

async function collectIds(
  supabase: ReturnType<typeof getSupabase>,
  table: string,
  selectColumn: string,
  filterColumn: string,
  filterValues: string[]
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < filterValues.length; i += CHUNK_SIZE) {
    const chunk = filterValues.slice(i, i + CHUNK_SIZE);
    const { data, error } = await supabase
      .from(table)
      .select(selectColumn)
      .in(filterColumn, chunk);
    if (error) {
      log.error("Chunked id-collect failed", error, { table, filterColumn });
      continue;
    }
    if (data) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ids.push(...data.map((r: any) => r[selectColumn]));
    }
  }
  return ids;
}

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
      log.error("Chunked delete failed", error, { table, column });
    }
  }
}
