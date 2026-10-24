-- migrations/0005_crum_parity.sql
-- Wave 1B data-layer parity: soft-delete marker for customers.
--
-- Why: contacts and followups are declared `ON DELETE CASCADE` in 0002, so a
-- hard `crm.delete_customer` would silently wipe a customer's entire history.
-- A nullable `deleted_at` timestamp lets the delete be a soft hide: the column
-- is NULL for live rows, and the read layer (queries.ts visibilityPredicate
-- call sites) filters `deleted_at IS NULL`.
--
-- Additive and safe on a shared database: `ADD COLUMN ... NULL` with no default
-- does not rewrite existing rows (Postgres stores the missing value as NULL in
-- the catalog). It does not drop or recreate any table.
--
-- Reversibility: this repo carries no down-migration convention (the runner
-- only tracks applied versions in crum_schema_migrations and forward-fixes).
-- A column-level undo is therefore `ALTER TABLE customers DROP COLUMN deleted_at`
-- if it is ever needed; nothing else depends on the column existing.
--
-- Do not add BEGIN or COMMIT. scripts/db-migrate.ts wraps this file and its
-- version row in a single transaction; a transaction inside the file would
-- commit the DDL before the version row is written.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Partial index keeps soft-delete-aware customer reads cheap without bloating
-- the table with rows that are only ever filtered out. IF NOT EXISTS so a
-- partially applied migration can be retried.
CREATE INDEX IF NOT EXISTS idx_customers_live
  ON customers (tenant_id, owner_id)
  WHERE deleted_at IS NULL;
