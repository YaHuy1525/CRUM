-- migrations/0023_crum_outreach_ledger.sql
-- Tracks outbound outreach sends for cap enforcement.
-- One row per send, keyed by tenant + prospect + timestamp.
-- The ledger is append-only; caps are computed by filtering rows, not by counters.

CREATE TABLE IF NOT EXISTS outreach_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  prospect_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('instagram', 'linkedin', 'facebook', 'tiktok', 'shopee', 'email')),
  kind text NOT NULL CHECK (kind IN ('dm', 'email', 'manual')),
  sent_at timestamptz NOT NULL DEFAULT now()
);

-- Index for cap checks: filter by tenant + kind + day
CREATE INDEX IF NOT EXISTS idx_outreach_ledger_tenant_kind_sent
  ON outreach_ledger (tenant_id, kind, sent_at DESC);

-- Index for cooldown checks: filter by tenant + prospect
CREATE INDEX IF NOT EXISTS idx_outreach_ledger_tenant_prospect
  ON outreach_ledger (tenant_id, prospect_id, sent_at DESC);
