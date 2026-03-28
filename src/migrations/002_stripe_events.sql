-- ============================================
-- STRIPE WEBHOOK IDEMPOTENCY
-- Run this in the Supabase SQL Editor
-- ============================================

-- Stores processed Stripe event IDs to prevent duplicate processing.
-- Stripe delivers webhooks at least once, so the same event may arrive
-- multiple times. The PRIMARY KEY on `id` (the Stripe event ID) lets us
-- do an atomic INSERT that fails with a unique-violation (23505) on
-- duplicates — no race conditions, no extra locks.
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,                    -- Stripe event ID (evt_xxx)
  event_type TEXT NOT NULL,               -- e.g. "checkout.session.completed"
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optional cleanup: DELETE FROM stripe_events WHERE processed_at < NOW() - INTERVAL '90 days';
-- Can be run via a Supabase cron extension (pg_cron) or external scheduler.
