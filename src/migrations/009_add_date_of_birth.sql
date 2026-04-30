-- Date of birth for age verification
--
-- Stores the user's DOB so age can be derived live on every sign-in. A single
-- nullable column on the existing `user_settings` table — no extra table, no
-- joins. NULL means the user has not yet completed age verification (pending);
-- a non-NULL value combined with the configured minimum age determines whether
-- they are verified or blocked. This avoids a separate "is_verified" flag and
-- means a user blocked at 12 progresses naturally when they return at 13.
--
-- Immutability is enforced at the API layer: only the dedicated onboarding
-- endpoint may set this column, and only when its current value is NULL. The
-- settings PUT endpoint excludes `date_of_birth` from its allowed-columns
-- whitelist so DOB cannot be changed via settings updates.
--
-- A CHECK constraint guards against obviously bogus dates (future, or implying
-- an age over 120) so a buggy client can't poison the row. Stored as DATE so
-- comparisons and age math use Postgres date arithmetic, not string juggling.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS date_of_birth DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_settings_date_of_birth_bounds'
  ) THEN
    ALTER TABLE user_settings
      ADD CONSTRAINT user_settings_date_of_birth_bounds
      CHECK (
        date_of_birth IS NULL
        OR (
          date_of_birth <= CURRENT_DATE
          AND date_of_birth >= CURRENT_DATE - INTERVAL '120 years'
        )
      );
  END IF;
END$$;
