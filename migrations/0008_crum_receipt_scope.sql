-- migrations/0008_crum_receipt_scope.sql
-- Wave 2B: the receipt has to record the scope it signed, or it cannot be
-- verified later.
--
-- Why: the HMAC input is `{ pendingWriteId, runId, scope, actionHash, approvedBy }`
-- (src/governance/receipt.ts, TECHNICAL_PLAN §12.3), but `audit_receipts`
-- persisted every field except `scope`. `GET /api/approvals/receipts/:id`
-- therefore cannot recompute the signature honestly — it would have to guess the
-- scope, and a wrong guess reports `signature_valid: false` on a receipt that is
-- perfectly fine. A verification that produces false alarms is worse than no
-- verification, because the first false alarm teaches the operator to ignore the
-- flag.
--
-- DEFAULT 'crm:write' backfills the rows that already exist with the only scope
-- the code has ever signed: `rejectPendingWrite` hard-codes it, and no approval
-- path was wired to pass another value. A future scope vocabulary changes this
-- default and stores the real scope per decision.
--
-- Additive, idempotent, and `ADD COLUMN ... NOT NULL DEFAULT` on a table with no
-- application-written rows is a metadata-only change.
--
-- Do not add BEGIN or COMMIT. scripts/db-migrate.ts wraps this file and its
-- version row in a single transaction.

ALTER TABLE audit_receipts
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'crm:write';

-- The verification read is keyed on the receipt id within a tenant, which the
-- primary key already covers. No index added here.
