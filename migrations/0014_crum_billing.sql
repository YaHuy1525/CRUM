-- Video billing & alerts (Phase 5): the money-out side of video revenue
-- tracking.  Phases 1-4 gather platform earnings (video_earnings) and brand-deal
-- income (sponsorship_income).  Phase 5 turns that into what a CRUM operator
-- owes / can bill a client, and surfaces the changes a human should look at.
--
-- Version 0014: next free number after 0013; scripts/db-migrate.ts keys
-- crum_schema_migrations on the 4-digit prefix, so 0001..0013 are taken.
--
-- Do not add BEGIN or COMMIT here; the runner wraps this file and its version
-- record in one transaction.
--
-- WHY THESE ARE THEIR OWN TABLES (and not pending_writes):
--   The governance plane's pending_writes.commitWithReceipt only understands a
--   fixed whitelist of objectTypes (customer/contact/followup/task/schedule/
--   knowledge_document/email).  Invoices and alerts are a different kind of
--   artifact, so they get their own tables with a LOCAL lifecycle instead of a
--   signed-receipt commit.  Nothing here is auto-sent: an invoice walks
--   draft -> approved -> issued by a human, and an alert is a row a human
--   acknowledges or dismisses.  This matches the repo rule that the assistant
--   never autonomously fires a workflow or sends a message.
--
-- Same conventions as 0002/0009/0012/0013: non-nullable tenant_id, tenant
-- predicate applied in the query layer, IF NOT EXISTS everywhere so a partial
-- apply can be retried, decimal for money (never float), a touch trigger on
-- updated_at, and bare-uuid owner_id (there is no `users` table to FK to).

-- ═══════════════════════════════════════════════════════════════════════════
--  client_billing_profiles — how a customer is billed.
--
--  One active profile per customer at a time (partial unique index below).
--  A profile is a policy, not a transaction, so it is soft-editable: change the
--  model/percentage going forward without rewriting history (history lives on
--  the invoice that was generated from it).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS client_billing_profiles (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL,
  -- The client being billed. Not NULL because a profile is meaningless without
  -- a customer; FK with RESTRICT so you cannot delete a customer that still has
  -- a billing policy pointed at it.
  customer_id         uuid        NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  -- Who owns/created the profile. Bare uuid (no `users` table), nullable so a
  -- migration/seed can write it without a logged-in user.
  owner_id            uuid,
  -- How the management fee is computed against a client's confirmed revenue.
  fee_model           varchar(20) NOT NULL DEFAULT 'pct_of_revenue'
                        CHECK (fee_model IN ('pct_of_revenue', 'flat_retainer', 'hybrid')),
  -- Management fee as a percentage (0-100) when the model uses a percentage.
  -- Nullable so a pure flat retainer can leave it unset.
  management_fee_pct  decimal(6,3),
  -- Flat retainer amount when the model uses one. Nullable for pure-percentage
  -- profiles.  decimal for money, never float.
  flat_amount         decimal(12,2),
  currency            varchar(3)  NOT NULL DEFAULT 'USD',
  billing_period      varchar(10) NOT NULL DEFAULT 'monthly'
                        CHECK (billing_period IN ('monthly', 'quarterly')),
  -- Whether a fee charged on the client's revenue also applies to sponsorship
  -- income, or only to platform (ad) revenue. Default true: the operator bills
  -- on all confirmed client revenue.
  bill_on_sponsorship boolean     NOT NULL DEFAULT true,
  active              boolean     NOT NULL DEFAULT true,
  -- Validity window so the same customer can have a changed policy over time.
  valid_from          date        NOT NULL DEFAULT current_date,
  valid_to            date,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_profiles_tenant
  ON client_billing_profiles (tenant_id, customer_id);

-- At most one ACTIVE profile per customer. A partial unique index (not a plain
-- column UNIQUE) so retired profiles (active=false) can accumulate as history.
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_profile_active_customer
  ON client_billing_profiles (tenant_id, customer_id)
  WHERE active;

DROP TRIGGER IF EXISTS trg_billing_profiles_touch ON client_billing_profiles;
CREATE TRIGGER trg_billing_profiles_touch BEFORE UPDATE ON client_billing_profiles
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
--  billing_invoices — a billing artifact for one customer over one period.
--
--  Generated from the revenue aggregates + the customer's active billing
--  profile.  The fee inputs are SNAPSHOT onto the row (fee_model/fee_pct/
--  flat_amount and the revenue breakdown) so that editing the profile later
--  never silently rewrites an already-issued invoice.
--
--  Local lifecycle: draft -> approved -> issued, plus void.  This is a state
--  column, NOT the governance pending_writes path.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS billing_invoices (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL,
  customer_id          uuid        NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  -- The billing profile this invoice was computed from (nullable if the profile
  -- was deleted after generation; the snapshot columns below still stand).
  billing_profile_id   uuid        REFERENCES client_billing_profiles(id) ON DELETE SET NULL,
  owner_id             uuid,
  period_start         date        NOT NULL,
  period_end           date        NOT NULL,
  -- Which channels rolled into this invoice (client-owned video_channels).
  channel_ids          uuid[]      NOT NULL DEFAULT '{}',
  -- Revenue breakdown for the period. decimal for money; text preserved by the
  -- query layer as-is. platform = ad/creator revenue (video_earnings),
  -- sponsorship = confirmed brand deals (sponsorship_income).
  platform_revenue     decimal(14,2) NOT NULL DEFAULT 0,
  sponsorship_revenue  decimal(14,2) NOT NULL DEFAULT 0,
  gross_revenue        decimal(14,2) NOT NULL DEFAULT 0,
  currency             varchar(3)  NOT NULL DEFAULT 'USD',
  -- Fee parameters SNAPSHOT at generation time.
  fee_model            varchar(20) NOT NULL
                         CHECK (fee_model IN ('pct_of_revenue', 'flat_retainer', 'hybrid')),
  fee_pct              decimal(6,3),
  fee_flat_amount      decimal(12,2),
  -- The amount actually billed (management fee owed to the operator).
  computed_amount      decimal(14,2) NOT NULL DEFAULT 0,
  -- Machine-readable trace of the calculation, for audit/recompute checks.
  line_items           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status               varchar(12) NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'approved', 'issued', 'void')),
  -- Human-facing number, unique per tenant. Generated in the query layer
-- (e.g. INV-2026-0001); nullable until issued.
  invoice_number       varchar(40),
  issued_at            timestamptz,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- One invoice per (customer, period) so regeneration is idempotent.
  CONSTRAINT uq_invoice_customer_period UNIQUE (tenant_id, customer_id, period_start, period_end),
  CONSTRAINT chk_invoice_period CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_invoices_tenant_status
  ON billing_invoices (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_invoices_customer_period
  ON billing_invoices (customer_id, period_start DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_number_tenant
  ON billing_invoices (tenant_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

DROP TRIGGER IF EXISTS trg_billing_invoices_touch ON billing_invoices;
CREATE TRIGGER trg_billing_invoices_touch BEFORE UPDATE ON billing_invoices
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
--  revenue_alerts — "something changed, a human should look".
--
--  Produced by the alert/detection workflow (drop/spike/new-sponsorship/
--  sync-failure).  An alert is ONLY a row + an optional human task; nothing is
--  sent automatically.  Dedup on (tenant, kind, dedup_key, open-ish window) is
--  handled in the query layer via a partial unique index so the same condition
--  does not spam a new row every daily sync while one is already open.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS revenue_alerts (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  -- At least one of channel/customer usually, both nullable so a tenant-wide
  -- alert (e.g. a whole-platform sync failure) can exist without a single
  -- target.
  channel_id   uuid        REFERENCES video_channels(id) ON DELETE SET NULL,
  customer_id  uuid        REFERENCES customers(id)      ON DELETE SET NULL,
  owner_id     uuid,
  kind         varchar(24) NOT NULL
                 CHECK (kind IN ('revenue_drop', 'revenue_spike', 'new_sponsorship', 'sync_failure')),
  severity     varchar(10) NOT NULL DEFAULT 'info'
                 CHECK (severity IN ('info', 'warning', 'critical')),
  message      text        NOT NULL,
  -- Numbers that triggered this alert (current vs prior, pct change, etc.) so
  -- the UI can render detail without recomputing.
  metrics      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Stable identity of the underlying condition for de-duplication
  -- (e.g. '<channel_id>:<date>' for a drop, '<channel_id>:<platform>' for a
  -- sync failure).  Paired with the partial unique index below.
  dedup_key    varchar(160) NOT NULL,
  status       varchar(16) NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'acknowledged', 'dismissed')),
  acknowledged_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alerts_tenant_status
  ON revenue_alerts (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_channel
  ON revenue_alerts (channel_id);

-- While an alert of the same (tenant, kind, dedup_key) is still 'open', a
-- re-detection must not create a duplicate. Once acknowledged/dismissed, a new
-- occurrence may open a fresh alert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_open_dedup
  ON revenue_alerts (tenant_id, kind, dedup_key)
  WHERE status = 'open';

DROP TRIGGER IF EXISTS trg_revenue_alerts_touch ON revenue_alerts;
CREATE TRIGGER trg_revenue_alerts_touch BEFORE UPDATE ON revenue_alerts
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();
