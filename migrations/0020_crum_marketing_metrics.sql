-- migrations/0020_crum_marketing_metrics.sql
-- Slice 3 adds a table to store periodic reads of campaign metrics from Meta's
-- API, so the analyst can compare periods and see trends. The parent spec
-- section 4.1 names the columns; this migration is the DDL.

CREATE TABLE IF NOT EXISTS marketing_metrics_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  bundle_id uuid NOT NULL,
  campaign_external_id text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  metrics jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_marketing_metrics_snapshots_tenant_bundle
  ON marketing_metrics_snapshots (tenant_id, bundle_id);

CREATE INDEX IF NOT EXISTS idx_marketing_metrics_snapshots_campaign
  ON marketing_metrics_snapshots (campaign_external_id);

CREATE INDEX IF NOT EXISTS idx_marketing_metrics_snapshots_window
  ON marketing_metrics_snapshots (window_start, window_end);
