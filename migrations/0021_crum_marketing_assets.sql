-- migrations/0021_crum_marketing_assets.sql
-- Slice 4 stores a generated marketing image as a document, records what each
-- image cost, and keeps one written prediction per staged approval. See
-- docs/superpowers/specs/2026-11-01-marketing-team-slice-4-design.md sections
-- 4.1 to 4.3. The headline is what this migration does NOT do: it adds no byte
-- column, because migrations/0011 already built the byte lane (document_files)
-- and a second place to put bytes on one entity is two sources of truth about
-- whether a document has a file.

-- 1. documents gains a kind and a source for generated assets. DROP/ADD is the
-- house style for widening a CHECK (0015, 0018, 0019 all do it): an in-place
-- rename would leave the old list in place.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check
  CHECK (kind IN ('invoice', 'contract', 'other', 'marketing_asset'));

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_source_check;
ALTER TABLE documents ADD CONSTRAINT documents_source_check
  CHECK (source IN ('upload', 'email', 'generated'));

-- The asset list is read by kind, and only by kind; a partial index keeps the
-- CRM's invoice and contract rows out of it entirely.
CREATE INDEX IF NOT EXISTS idx_documents_assets
  ON documents (tenant_id, kind, status)
  WHERE kind = 'marketing_asset';

-- 2. The daily spend ceiling needs a number to compare against, so it needs a
-- ledger. Append-only and with no updated_at, for the same reason audit_receipts
-- has neither: a spend that happened is never edited.
CREATE TABLE IF NOT EXISTS marketing_image_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  -- Nullable on purpose. A prediction that produced no usable bytes still cost
  -- money, and an invoice we cannot attribute to a document is the truth rather
  -- than a gap in the arithmetic.
  document_id uuid,
  provider text NOT NULL,
  cost_minor integer NOT NULL,
  -- The prediction handle, kept even when there are no bytes to point at. Spec
  -- section 9's row "bytes download fails after a successful prediction" says the
  -- owner can re-fetch from Replicate within its expiry window, and that is only
  -- true if the row says *which* prediction. Nothing reads it back automatically.
  raw_extract jsonb,
  spent_on date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_image_spend_cost_non_negative CHECK (cost_minor >= 0)
);

CREATE INDEX IF NOT EXISTS idx_marketing_image_spend_tenant_day
  ON marketing_image_spend (tenant_id, spent_on);

-- 3. The forcing record. One row per staged draft, forever: the unique
-- constraint is what makes "type it before you look" a fact about the database
-- rather than an instruction on a screen. pending_write_id rather than
-- bundle_id, so a re-staged bundle is a fresh prediction.
CREATE TABLE IF NOT EXISTS reviewer_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  pending_write_id uuid NOT NULL REFERENCES pending_writes(id) ON DELETE CASCADE,
  predicted_outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_prediction_draft UNIQUE (pending_write_id)
);
