-- Public share links for conversations
--
-- Users can create a read-only share link for a conversation. Anyone with the
-- unguessable share_token (UUID) can view the conversation up to snapshot_at.
-- The owner can refresh the snapshot (PATCH) to include new messages, or
-- revoke the link (DELETE → revoked_at).
--
-- Design notes:
--   * share_token is the PRIMARY KEY so the public URL never exposes the real
--     conversation_id. Using gen_random_uuid() keeps tokens unguessable.
--   * A partial unique index enforces at most one ACTIVE share per
--     conversation; POSTing again on a conversation that is already shared
--     returns the existing token (upsert pattern).
--   * ON DELETE CASCADE on conversation_id means deleting a conversation
--     automatically removes any share rows.

CREATE TABLE IF NOT EXISTS shared_conversations (
  share_token     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  title_snapshot  TEXT,
  snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  view_count      INTEGER NOT NULL DEFAULT 0
);

-- At most one active share per conversation (revoked rows are ignored).
CREATE UNIQUE INDEX IF NOT EXISTS shared_conversations_active_conv_idx
  ON shared_conversations (conversation_id)
  WHERE revoked_at IS NULL;

-- Fast lookup for "list my shared chats".
CREATE INDEX IF NOT EXISTS shared_conversations_user_idx
  ON shared_conversations (user_id, created_at DESC);

-- Atomic view counter. Called from the public GET endpoint so viewers don't
-- race against each other. Wrapped in a function so PostgREST exposes it as
-- an RPC callable from the service-role client.
CREATE OR REPLACE FUNCTION increment_share_view_count(token UUID)
RETURNS void AS $$
  UPDATE shared_conversations
     SET view_count = view_count + 1
   WHERE share_token = token
     AND revoked_at IS NULL;
$$ LANGUAGE SQL;
