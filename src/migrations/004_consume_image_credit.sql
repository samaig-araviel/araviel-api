-- ============================================
-- ATOMIC IMAGE CREDIT CONSUMPTION
-- Run this in the Supabase SQL Editor.
--
-- Replaces the read-then-write logic previously performed in TypeScript by
-- chargeCredits() in src/lib/credits.ts. All decision + mutation logic runs
-- inside a single PL/pgSQL function under row-level locks, so concurrent
-- image generations for the same user can never double-spend.
--
-- Mirrors the pattern used by consume_text_credit() for text credits.
--
-- Default free-tier allowance (monthly_image_credits = 5) matches
-- TIER_MONTHLY_CREDITS.free in src/lib/credits.ts — keep in sync.
-- Billing cycle length (30 days) matches BILLING_CYCLE_DAYS in the same file.
-- Required indexes for performance are already provided by 001_image_credits.sql:
--   - credit_accounts: UNIQUE(user_id), idx_credit_accounts_user
--   - credit_packs:    idx_credit_packs_user (user_id, feature, expires_at)
-- ============================================

CREATE OR REPLACE FUNCTION consume_image_credit(
  p_user_id         TEXT,
  p_cost            INT,
  p_quality         TEXT,
  p_model           TEXT,
  p_provider        TEXT,
  p_conversation_id TEXT,
  p_message_id      TEXT,
  p_prompt_snippet  TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account         credit_accounts%ROWTYPE;
  v_monthly_remaining INT;
  v_pack            credit_packs%ROWTYPE;
  v_split_pack      credit_packs%ROWTYPE;
  v_from_pack       INT;
  v_remaining_monthly INT;
  v_remaining_packs   INT;
BEGIN
  -- Bound the time any single call can hold a row lock.
  SET LOCAL statement_timeout = '3s';

  IF p_cost IS NULL OR p_cost <= 0 THEN
    RAISE EXCEPTION 'consume_image_credit: p_cost must be positive, got %', p_cost;
  END IF;

  -- Ensure the account row exists, then lock it. UNIQUE(user_id) makes the
  -- upsert safe under concurrency; the subsequent SELECT ... FOR UPDATE
  -- serializes every concurrent charge for this user.
  INSERT INTO credit_accounts (
    user_id, tier, monthly_image_credits, monthly_image_credits_used, billing_cycle_start
  )
  VALUES (p_user_id, 'free', 5, 0, NOW())
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_account
  FROM credit_accounts
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- Apply billing-cycle reset under the same lock so charges can never race
  -- against the reset. Mirrors the logic in getOrCreateAccount().
  IF (NOW() - v_account.billing_cycle_start) >= INTERVAL '30 days' THEN
    UPDATE credit_accounts
    SET monthly_image_credits_used = 0,
        billing_cycle_start        = NOW(),
        updated_at                 = NOW()
    WHERE id = v_account.id
    RETURNING * INTO v_account;
  END IF;

  v_monthly_remaining := v_account.monthly_image_credits - v_account.monthly_image_credits_used;

  -- ── Path 1: charge entirely from monthly ─────────────────────────────────
  IF v_monthly_remaining >= p_cost THEN
    UPDATE credit_accounts
    SET monthly_image_credits_used = monthly_image_credits_used + p_cost,
        updated_at                 = NOW()
    WHERE id = v_account.id;

    INSERT INTO credit_usage_log (
      user_id, feature, quality, credits_charged, source,
      model_used, provider, conversation_id, message_id, prompt_snippet
    )
    VALUES (
      p_user_id, 'image', p_quality, p_cost, 'monthly',
      p_model, p_provider, p_conversation_id, p_message_id, p_prompt_snippet
    );

    v_remaining_monthly := v_monthly_remaining - p_cost;

    SELECT COALESCE(SUM(credits_total - credits_used), 0) INTO v_remaining_packs
    FROM credit_packs
    WHERE user_id = p_user_id
      AND feature = 'image'
      AND expires_at > NOW();

    RETURN jsonb_build_object(
      'charged',           true,
      'credits_charged',   p_cost,
      'source',            'monthly',
      'source_id',         NULL,
      'remaining_monthly', v_remaining_monthly,
      'remaining_packs',   v_remaining_packs
    );
  END IF;

  -- ── Path 2: charge entirely from a single non-expired pack (FIFO) ────────
  SELECT * INTO v_pack
  FROM credit_packs
  WHERE user_id    = p_user_id
    AND feature    = 'image'
    AND expires_at > NOW()
    AND (credits_total - credits_used) >= p_cost
  ORDER BY purchased_at ASC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    UPDATE credit_packs
    SET credits_used = credits_used + p_cost
    WHERE id = v_pack.id;

    INSERT INTO credit_usage_log (
      user_id, feature, quality, credits_charged, source, source_id,
      model_used, provider, conversation_id, message_id, prompt_snippet
    )
    VALUES (
      p_user_id, 'image', p_quality, p_cost, 'pack', v_pack.id,
      p_model, p_provider, p_conversation_id, p_message_id, p_prompt_snippet
    );

    v_remaining_monthly := v_monthly_remaining;

    SELECT COALESCE(SUM(credits_total - credits_used), 0) INTO v_remaining_packs
    FROM credit_packs
    WHERE user_id = p_user_id
      AND feature = 'image'
      AND expires_at > NOW();

    RETURN jsonb_build_object(
      'charged',           true,
      'credits_charged',   p_cost,
      'source',            'pack',
      'source_id',         v_pack.id,
      'remaining_monthly', v_remaining_monthly,
      'remaining_packs',   v_remaining_packs
    );
  END IF;

  -- ── Path 3: split between remaining monthly and a single pack ────────────
  IF v_monthly_remaining > 0 THEN
    v_from_pack := p_cost - v_monthly_remaining;

    SELECT * INTO v_split_pack
    FROM credit_packs
    WHERE user_id    = p_user_id
      AND feature    = 'image'
      AND expires_at > NOW()
      AND (credits_total - credits_used) >= v_from_pack
    ORDER BY purchased_at ASC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      UPDATE credit_accounts
      SET monthly_image_credits_used = monthly_image_credits,
          updated_at                 = NOW()
      WHERE id = v_account.id;

      UPDATE credit_packs
      SET credits_used = credits_used + v_from_pack
      WHERE id = v_split_pack.id;

      INSERT INTO credit_usage_log (
        user_id, feature, quality, credits_charged, source,
        model_used, provider, conversation_id, message_id, prompt_snippet
      )
      VALUES (
        p_user_id, 'image', p_quality, v_monthly_remaining, 'monthly',
        p_model, p_provider, p_conversation_id, p_message_id, p_prompt_snippet
      );

      INSERT INTO credit_usage_log (
        user_id, feature, quality, credits_charged, source, source_id,
        model_used, provider, conversation_id, message_id, prompt_snippet
      )
      VALUES (
        p_user_id, 'image', p_quality, v_from_pack, 'pack', v_split_pack.id,
        p_model, p_provider, p_conversation_id, p_message_id, p_prompt_snippet
      );

      v_remaining_monthly := 0;

      SELECT COALESCE(SUM(credits_total - credits_used), 0) INTO v_remaining_packs
      FROM credit_packs
      WHERE user_id = p_user_id
        AND feature = 'image'
        AND expires_at > NOW();

      RETURN jsonb_build_object(
        'charged',           true,
        'credits_charged',   p_cost,
        'source',            'pack',
        'source_id',         v_split_pack.id,
        'remaining_monthly', v_remaining_monthly,
        'remaining_packs',   v_remaining_packs
      );
    END IF;
  END IF;

  -- ── Path 4: insufficient credits ─────────────────────────────────────────
  SELECT COALESCE(SUM(credits_total - credits_used), 0) INTO v_remaining_packs
  FROM credit_packs
  WHERE user_id = p_user_id
    AND feature = 'image'
    AND expires_at > NOW();

  RETURN jsonb_build_object(
    'charged',           false,
    'credits_charged',   0,
    'source',            'monthly',
    'source_id',         NULL,
    'remaining_monthly', v_monthly_remaining,
    'remaining_packs',   v_remaining_packs
  );
END;
$$;

REVOKE ALL ON FUNCTION consume_image_credit(TEXT, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consume_image_credit(TEXT, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
