-- ============================================
-- USER PROFILES + AGE GATE
-- Run this in the Supabase SQL Editor.
--
-- Goals:
--   1. Persist a tamper-resistant copy of the user's date of birth
--      outside of auth.users.raw_user_meta_data (which is mutable
--      from the client via supabase.auth.updateUser).
--   2. Lock birth_date once it is set so a user can't rewrite their
--      age after the fact.
--   3. Block under-13 signups at the DB layer as a defence-in-depth
--      backstop alongside the client-side age gate.
-- ============================================

-- 1) profiles table — one row per non-anonymous auth user.
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  birth_date DATE,
  age_verified_at TIMESTAMPTZ,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_birth_date ON public.profiles(birth_date);

COMMENT ON TABLE  public.profiles IS
  'Application-side user profile. Authoritative copy of birth_date; auth.users.raw_user_meta_data.birth_date is a client-readable mirror.';
COMMENT ON COLUMN public.profiles.birth_date IS
  'Immutable once set. Enforced by the sync_user_birth_date trigger and by the no-update RLS posture.';
COMMENT ON COLUMN public.profiles.age_verified_at IS
  'Timestamp when birth_date was first persisted.';


-- 2) Row-level security: read your own profile only. Inserts/updates
--    from clients are denied by the absence of any policy for those
--    actions; all writes go through the SECURITY DEFINER triggers
--    below or the service role.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);


-- 3) on_auth_user_created — auto-create a profile row whenever a new
--    non-anonymous auth.users row is inserted. If a birth_date came
--    in via signUp options.data, copy it across and stamp
--    age_verified_at. Under-13 signups are rejected here so they
--    never get an auth.users row in the first place.
CREATE OR REPLACE FUNCTION public.handle_new_user_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_birth_date DATE;
  v_age        INT;
BEGIN
  -- Anonymous (guest) users don't get a profile row. They have
  -- no real identity yet.
  IF COALESCE(NEW.is_anonymous, FALSE) THEN
    RETURN NEW;
  END IF;

  v_birth_date := NULLIF(NEW.raw_user_meta_data->>'birth_date', '')::DATE;

  IF v_birth_date IS NOT NULL THEN
    v_age := EXTRACT(YEAR FROM AGE(v_birth_date))::INT;
    IF v_age < 13 THEN
      RAISE EXCEPTION 'User must be at least 13 years old'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  INSERT INTO public.profiles (
    id, birth_date, age_verified_at, display_name, created_at, updated_at
  )
  VALUES (
    NEW.id,
    v_birth_date,
    CASE WHEN v_birth_date IS NOT NULL THEN NOW() ELSE NULL END,
    NULLIF(NEW.raw_user_meta_data->>'display_name', ''),
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user_profile();


-- 4) sync_user_birth_date — when a user updates their metadata, mirror
--    raw_user_meta_data.birth_date into profiles.birth_date, but
--    *only* if the profile's birth_date is still null. Once a value
--    is recorded it is locked: subsequent metadata changes are
--    ignored, so a user calling supabase.auth.updateUser to lie
--    about their age can no longer move the authoritative copy.
--    Under-13 values are also rejected here so a user who tries to
--    set a young DOB after signing up gets a hard error.
CREATE OR REPLACE FUNCTION public.sync_user_birth_date()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta_birth_date     DATE;
  v_existing_birth_date DATE;
  v_age                 INT;
BEGIN
  IF COALESCE(NEW.is_anonymous, FALSE) THEN
    RETURN NEW;
  END IF;

  v_meta_birth_date := NULLIF(NEW.raw_user_meta_data->>'birth_date', '')::DATE;
  IF v_meta_birth_date IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT birth_date INTO v_existing_birth_date
  FROM public.profiles
  WHERE id = NEW.id;

  -- Already locked → ignore the metadata change. Do not raise an
  -- error: the client may legitimately call updateUser with the
  -- existing value during refresh flows.
  IF v_existing_birth_date IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_age := EXTRACT(YEAR FROM AGE(v_meta_birth_date))::INT;
  IF v_age < 13 THEN
    RAISE EXCEPTION 'User must be at least 13 years old'
      USING ERRCODE = '22023';
  END IF;

  -- Profile row should exist (created by handle_new_user_profile)
  -- but be defensive in case backfill missed a user.
  INSERT INTO public.profiles (id, created_at, updated_at)
  VALUES (NEW.id, NOW(), NOW())
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.profiles
     SET birth_date      = v_meta_birth_date,
         age_verified_at = NOW(),
         updated_at      = NOW()
   WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_birth_date_updated ON auth.users;
CREATE TRIGGER on_auth_user_birth_date_updated
  AFTER UPDATE OF raw_user_meta_data ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_user_birth_date();


-- 5) Backfill: create profile rows for any non-anonymous users that
--    existed before this migration ran. Lifts any DOB already on
--    user_metadata. Skips under-13 rows by inserting them with a
--    null birth_date so the application's age gate will route them
--    through verify-age on next sign-in (or sign them out).
INSERT INTO public.profiles (
  id, birth_date, age_verified_at, display_name, created_at, updated_at
)
SELECT
  u.id,
  CASE
    WHEN NULLIF(u.raw_user_meta_data->>'birth_date', '') IS NOT NULL
         AND EXTRACT(YEAR FROM AGE((u.raw_user_meta_data->>'birth_date')::DATE)) >= 13
      THEN (u.raw_user_meta_data->>'birth_date')::DATE
    ELSE NULL
  END,
  CASE
    WHEN NULLIF(u.raw_user_meta_data->>'birth_date', '') IS NOT NULL
         AND EXTRACT(YEAR FROM AGE((u.raw_user_meta_data->>'birth_date')::DATE)) >= 13
      THEN NOW()
    ELSE NULL
  END,
  NULLIF(u.raw_user_meta_data->>'display_name', ''),
  COALESCE(u.created_at, NOW()),
  NOW()
FROM auth.users u
WHERE COALESCE(u.is_anonymous, FALSE) = FALSE
ON CONFLICT (id) DO NOTHING;
