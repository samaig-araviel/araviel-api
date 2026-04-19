import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

/**
 * Thin DB helper for the title-generation flow. Kept separate from the
 * LLM module (title-generator.ts) so each file has a single responsibility
 * and each is trivial to mock in isolation.
 */

export interface UpdateConversationTitleOptions {
  /** Correlates the DB log line with the originating chat request. */
  requestId?: string;
}

/**
 * Race-safe update: writes `newTitle` only when the row's current title
 * still equals `expectedTitle`. This prevents overwriting a manual rename
 * that may have happened between placeholder insert and title generation.
 *
 * Returns `true` when the row was updated, `false` when it was not
 * (row missing, title already changed, or DB error — all of which mean
 * "don't emit the title SSE event").
 */
export async function updateConversationTitleIfUnchanged(
  conversationId: string,
  expectedTitle: string,
  newTitle: string,
  options: UpdateConversationTitleOptions = {},
): Promise<boolean> {
  const log = logger.child({
    route: "conversation-title-updater",
    requestId: options.requestId,
    conversationId,
  });

  if (newTitle === expectedTitle) {
    // No-op: placeholder happens to match the generated title exactly.
    return false;
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("conversations")
      .update({ title: newTitle, updated_at: new Date().toISOString() })
      .eq("id", conversationId)
      .eq("title", expectedTitle)
      .select("id");

    if (error) {
      log.warn("Title update failed", undefined, error);
      return false;
    }

    const updated = Array.isArray(data) && data.length > 0;
    if (!updated) {
      // Either the row was renamed between placeholder insert and now,
      // or the conversation was deleted. Both are expected outcomes —
      // log at debug, not warn.
      log.debug("Title update skipped (title changed or row missing)");
    }

    return updated;
  } catch (err) {
    log.warn("Title update threw unexpectedly", undefined, err);
    return false;
  }
}
