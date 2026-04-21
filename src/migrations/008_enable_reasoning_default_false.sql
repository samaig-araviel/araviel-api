-- Flip enable_reasoning default to false
--
-- Extended thinking is off by default for new rows going forward. Existing
-- user rows are intentionally left untouched so a user who explicitly opted
-- in keeps reasoning on — we cannot distinguish "accepted the old default"
-- from "explicitly chose true" after the fact.
--
-- Idempotent: setting a DEFAULT is a metadata-only change, safe to re-run.

ALTER TABLE user_settings
  ALTER COLUMN enable_reasoning SET DEFAULT false;
