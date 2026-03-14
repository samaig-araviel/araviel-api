-- ============================================
-- IMAGE GENERATION CREDIT SYSTEM
-- Run this in the Supabase SQL Editor
-- ============================================

-- 1. Credit accounts — one row per user
-- Tracks monthly image credit allocation and usage per billing cycle.
-- When user auth is added: add FK to auth.users, enable RLS with
--   USING (user_id = auth.uid())
CREATE TABLE credit_accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'free'
    CHECK (tier IN ('free', 'pro', 'premium')),
  monthly_image_credits INT NOT NULL DEFAULT 5,
  monthly_image_credits_used INT NOT NULL DEFAULT 0,
  billing_cycle_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_credit_accounts_user ON credit_accounts(user_id);


-- 2. Credit transactions — purchase records (checkout flow)
-- Built for Stripe integration later. For now, transactions are created
-- and immediately completed. When Stripe is added:
--   ALTER TABLE credit_transactions ADD COLUMN stripe_payment_id TEXT;
--   ALTER TABLE credit_transactions ADD COLUMN stripe_session_id TEXT;
-- Flow becomes: pending → (Stripe webhook) → completed
CREATE TABLE credit_transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  pack_type TEXT NOT NULL
    CHECK (pack_type IN ('starter', 'creator', 'studio')),
  feature TEXT NOT NULL DEFAULT 'image'
    CHECK (feature IN ('image', 'voice', 'video', 'general')),
  credits INT NOT NULL,
  amount_cents INT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  completed_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_credit_transactions_user ON credit_transactions(user_id, status);
CREATE INDEX idx_credit_transactions_created ON credit_transactions(created_at);


-- 3. Credit packs — purchased add-on credit bundles
-- Each completed transaction creates one pack. Packs expire after 90 days.
-- Monthly credits are consumed first, then oldest non-expired pack (FIFO).
CREATE TABLE credit_packs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id UUID REFERENCES credit_transactions(id),
  feature TEXT NOT NULL DEFAULT 'image'
    CHECK (feature IN ('image', 'voice', 'video', 'general')),
  credits_total INT NOT NULL CHECK (credits_total > 0),
  credits_used INT NOT NULL DEFAULT 0,
  purchased_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT credits_remaining CHECK (credits_used <= credits_total)
);

CREATE INDEX idx_credit_packs_user ON credit_packs(user_id, feature, expires_at);
CREATE INDEX idx_credit_packs_active ON credit_packs(user_id, feature)
  WHERE credits_used < credits_total;


-- 4. Credit usage log — append-only audit trail
-- Every credit charge writes one row. Used for analytics, daily limit
-- checks, and future billing reconciliation.
CREATE TABLE credit_usage_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL,
  feature TEXT NOT NULL DEFAULT 'image'
    CHECK (feature IN ('image', 'voice', 'video', 'general')),
  quality TEXT
    CHECK (quality IS NULL OR quality IN ('standard', 'hd', 'ultra')),
  credits_charged INT NOT NULL CHECK (credits_charged > 0),
  source TEXT NOT NULL
    CHECK (source IN ('monthly', 'pack')),
  source_id UUID,                       -- pack ID when source = 'pack'
  model_used TEXT,
  provider TEXT,
  conversation_id TEXT,
  message_id TEXT,
  prompt_snippet TEXT,                  -- first 100 chars of prompt
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_credit_usage_user ON credit_usage_log(user_id, feature, created_at);
