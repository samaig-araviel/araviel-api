-- Usage limit warning thresholds
--
-- Adds a user-configurable list of "remaining %" tripwires to the existing
-- user_settings row. Stored as an INT[] so we can index on membership and
-- range-query in the future (e.g. "users who still want a 50% nudge").
--
-- Defaults mirror the frontend defaults in DEFAULT_SETTINGS so a row written
-- by an older client — or a fresh signup before the client saves — still
-- gets the expected warnings.
--
-- Backfill strategy: existing rows get the default via the column default;
-- no explicit UPDATE is needed because the column is NOT NULL with a default.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS usage_limit_thresholds INT[]
    NOT NULL
    DEFAULT ARRAY[20, 10, 5]::INT[];

-- Guard against nonsensical values (thresholds are percentages, 1-100).
-- Using a CHECK constraint keeps the API layer thin and the DB honest.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_settings_usage_limit_thresholds_bounds'
  ) THEN
    ALTER TABLE user_settings
      ADD CONSTRAINT user_settings_usage_limit_thresholds_bounds
      CHECK (
        1 <= ALL(usage_limit_thresholds)
        AND 100 >= ALL(usage_limit_thresholds)
      );
  END IF;
END$$;
