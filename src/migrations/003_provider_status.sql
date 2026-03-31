-- Provider Status Dashboard tables
-- Tracks external AI provider health and Araveil platform health

-- Current status per provider (latest check result)
CREATE TABLE IF NOT EXISTS provider_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  source TEXT NOT NULL,
  status_page_raw TEXT,
  health_check_ok BOOLEAN,
  latency_ms INTEGER,
  error_message TEXT,
  components JSONB,
  incidents JSONB,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ps_valid_provider CHECK (
    provider IN ('anthropic', 'openai', 'google', 'perplexity', 'xai', 'elevenlabs')
  ),
  CONSTRAINT ps_valid_status CHECK (
    status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'unknown')
  ),
  CONSTRAINT ps_valid_source CHECK (
    source IN ('status_page', 'health_check', 'usage_derived', 'reconciled')
  )
);

CREATE INDEX IF NOT EXISTS idx_provider_status_lookup
  ON provider_status (provider, checked_at DESC);

-- Historical time-series for charting uptime and latency
CREATE TABLE IF NOT EXISTS provider_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  success_rate NUMERIC(5,2),
  error_rate NUMERIC(5,2),
  avg_response_ms INTEGER,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT psh_valid_provider CHECK (
    provider IN ('anthropic', 'openai', 'google', 'perplexity', 'xai', 'elevenlabs')
  ),
  CONSTRAINT psh_valid_status CHECK (
    status IN ('operational', 'degraded', 'partial_outage', 'major_outage', 'unknown')
  )
);

CREATE INDEX IF NOT EXISTS idx_psh_lookup
  ON provider_status_history (provider, checked_at DESC);

-- Araveil platform service health (ARC, ADE, Supabase)
CREATE TABLE IF NOT EXISTS platform_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  latency_ms INTEGER,
  error_message TEXT,
  metadata JSONB,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT plat_valid_service CHECK (
    service IN ('arc', 'ade', 'supabase')
  ),
  CONSTRAINT plat_valid_status CHECK (
    status IN ('operational', 'degraded', 'down', 'unknown')
  )
);

CREATE INDEX IF NOT EXISTS idx_platform_status_lookup
  ON platform_status (service, checked_at DESC);
