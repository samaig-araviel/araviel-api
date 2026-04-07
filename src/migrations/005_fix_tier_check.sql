-- ============================================
-- Fix tier CHECK constraint on credit_accounts
-- ============================================
-- The original migration used CHECK (tier IN ('free', 'pro', 'premium')).
-- 'premium' was never a valid tier in the application — all code uses 'lite' for the
-- middle tier. The Stripe webhook calls updateTier(userId, 'lite') on Lite plan
-- checkouts, which violated this constraint and prevented image credits from being
-- assigned to Lite subscribers.
--
-- Run this in the Supabase SQL Editor.

ALTER TABLE credit_accounts
  DROP CONSTRAINT IF EXISTS credit_accounts_tier_check;

ALTER TABLE credit_accounts
  ADD CONSTRAINT credit_accounts_tier_check
  CHECK (tier IN ('free', 'lite', 'pro'));

-- Backfill any rows that were incorrectly stored as 'premium'
UPDATE credit_accounts
  SET tier = 'lite'
  WHERE tier = 'premium';
