-- Slice 5 R3: the spend ledger learns which bundle the money was for.
--
-- The day ceiling has guarded this account since slice 4, and it does its job on
-- the invoice. It cannot stop one runaway loop on one bundle, because a bundle
-- that has already had forty images paid for still fits inside a $20 day and gets
-- forty more tomorrow. Answering that question needs an attribution the rows do
-- not carry today.
--
-- Nullable, and with no backfill: the rows written before this migration cannot be
-- attributed honestly, and inventing a bundle id for them would make a lifetime
-- ceiling read a number nobody paid. A NULL bundle contributes to the tenant's day
-- and to nothing else, which is the truth rather than a gap in the arithmetic.
--
-- No FOREIGN KEY, on the precedent of tenant_id and document_id on this same table
-- (migrations/0021_crum_marketing_assets.sql:32, 36): a ledger row must outlive the
-- thing it invoices, so a bundle that is later deleted must not take its spend row
-- with it, and a row whose bundle id points at nothing must still be readable.
ALTER TABLE marketing_image_spend ADD COLUMN IF NOT EXISTS bundle_id uuid;

-- The partial index matches the read that grows beside this column, which always
-- names a bundle: an unattributed row is nobody's bundle total, so it has no
-- business being in the index that answers one.
CREATE INDEX IF NOT EXISTS idx_marketing_image_spend_tenant_bundle
  ON marketing_image_spend (tenant_id, bundle_id)
  WHERE bundle_id IS NOT NULL;
