-- Sponsorship income: brand-deal revenue discovered by the Phase 4 email/message
-- scanner (and entered manually). The platform APIs expose no sponsorship
-- dollars, so this table — not video_earnings — is where brand-deal money lives.
--
-- Version 0013: next free number after 0012; scripts/db-migrate.ts keys
-- crum_schema_migrations on the 4-digit prefix.
--
-- Do not add BEGIN or COMMIT here; the runner wraps this file and its version
-- record in one transaction.
--
-- Semi-automated review model (same spirit as documents.status needs_review):
--   * every scanner-produced row lands as status='suggested'
--   * a human flips it to 'confirmed' (counts toward billing) or 'dismissed'
--   * (tenant_id, content_hash) is unique so re-scanning the same email/message
--     cannot create duplicate suggestions — mirrors documents' dedup on
--     content_hash.
--
-- Same conventions as 0002/0009/0012: non-nullable tenant_id, tenant predicate
-- applied in the query layer, IF NOT EXISTS everywhere so a partial apply can
-- be retried, decimal for money (never float), a touch trigger on updated_at.

CREATE TABLE IF NOT EXISTS sponsorship_income (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  -- Who recorded the deal. Nullable so a background scan can write without a
  -- logged-in user. There is no `users` table in this schema (see documents'
  -- owner_id in 0009, which is also an un-FK'd uuid), so this stays a bare
  -- uuid matching the identity plane's user id.
  owner_id      uuid,
  -- CRM resolution links, all nullable and all read-only (same pattern as
  -- video_channels' customer_id/contact_id in 0012). A deal may predate the
  -- channel or customer being linked.
  channel_id    uuid        REFERENCES video_channels(id) ON DELETE SET NULL,
  customer_id   uuid        REFERENCES customers(id)      ON DELETE SET NULL,
  contact_id    uuid        REFERENCES contacts(id)       ON DELETE SET NULL,
  brand_name    varchar(255),
  brand_email   varchar(320),
  deal_type     varchar(20) CHECK (deal_type IN
                  ('flat', 'cpm', 'rev_share', 'gift', 'affiliate', 'other')),
  amount        decimal(12,2),
  currency      varchar(3)  NOT NULL DEFAULT 'USD',
  deal_date     date,
  period_start  date,
  period_end    date,
  source        varchar(10) NOT NULL DEFAULT 'email'
                  CHECK (source IN ('email', 'manual', 'chat')),
  source_ref    text,
  content_hash  varchar(64) NOT NULL,
  confidence    decimal(4,3),
  status        varchar(16) NOT NULL DEFAULT 'suggested'
                  CHECK (status IN ('suggested', 'confirmed', 'dismissed')),
  raw_extract   jsonb       DEFAULT '{}'::jsonb,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sponsorship_content UNIQUE (tenant_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_sponsorship_tenant_status
  ON sponsorship_income (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_sponsorship_channel
  ON sponsorship_income (channel_id);

CREATE INDEX IF NOT EXISTS idx_sponsorship_customer
  ON sponsorship_income (customer_id);

CREATE INDEX IF NOT EXISTS idx_sponsorship_tenant_date
  ON sponsorship_income (tenant_id, deal_date DESC);

DROP TRIGGER IF EXISTS trg_sponsorship_touch ON sponsorship_income;
CREATE TRIGGER trg_sponsorship_touch BEFORE UPDATE ON sponsorship_income
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();
