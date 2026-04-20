import { getSupabase } from "./supabase";
import { logger } from "./logger";

/**
 * Race-safe conversation title update.
 *
 * Writes `newTitle` only when the row's current `title` still equals
 * `expectedTitle`. This prevents us from overwriting a manual rename that may
 * have happened between the time we created the row with a placeholder and
 * the time the LLM finished generating the descriptive title.
 *
 * Swallows DB errors and returns `false` — title generation is best-effort and
 * must never surface a user-facing failure.
 *
 * @returns `true` when the row was updated, `false` otherwise (no match, rename
 *          happened, same title, or DB error).
 *
 * @example
 * const ok = await updateConversationTitleIfUnchanged(id, "Old title...", "Diagnosing pytest OOM");
 * if (ok) { /* push title SSE event *\/ }
 */
export async function updateConversationTitleIfUnchanged(
  conversationId: string,
  expectedTitle: string,
  newTitle: string,
  options?: { requestId?: string },
): Promise<boolean> {
  if (newTitle === expectedTitle) return false;

  const log = logger.child({
    route: "conversation-title-updater",
    conversationId,
    requestId: options?.requestId,
  });

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("conversations")
      .update({ title: newTitle })
      .eq("id", conversationId)
      .eq("title", expectedTitle)
      .select("id");

    if (error) {
      log.warn("Title update failed", { error: error.message });
      return false;
    }

    const updated = Array.isArray(data) && data.length > 0;
    if (!updated) {
      log.debug("Title unchanged — placeholder no longer matched (likely manual rename)");
    }
    return updated;
  } catch (err) {
    log.warn("Title update threw", { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
