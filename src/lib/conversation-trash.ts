const DEFAULT_GRACE_DAYS = 15;

export function getConversationTrashGraceDays(): number {
  const raw = process.env.CONVERSATION_TRASH_GRACE_DAYS;
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_GRACE_DAYS;
  return Math.floor(parsed);
}

export function getTrashCutoffIso(): string {
  const days = getConversationTrashGraceDays();
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
