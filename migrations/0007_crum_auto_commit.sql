-- migrations/0007_crum_auto_commit.sql
-- Wave 2B: make the write path finish what it started.
--
-- Why these two columns:
--
-- 1. `committed_at` / `committed_record_id`. The `auto` gate is documented as
--    "idempotent, no receipt" (TECHNICAL_PLAN §4 architecture ASCII, §12.4), but
--    nothing in the codebase ever applied an auto draft: `crm.log_followup` and
--    `crm.create_task` inserted a `pending_writes` row, then answered "Followup
--    logged" / "Task created" while no `followups` or `tasks` row existed. The
--    queue could not hide them either, because `listPendingWrites` decides
--    "undecided" from `receipt_id IS NULL AND rejected_at IS NULL`, and an auto
--    write has neither — every auto write was permanently pending.
--    A receipt is the wrong instrument here: `audit_receipts` is the record of a
--    HUMAN decision (§12.3), and stamping one onto a low-risk auto write would
--    claim an approval that never happened. These two columns record what
--    actually occurred: the draft was applied, and here is the row it became.
--
-- 2. `object_type = 'email'`. `mail.draft` and `mail.send` staged themselves as
--    `knowledge_document`, which is false in a column the approval queue renders.
--    Nobody approved an email believing it was a document upload. A seventh type
--    lets the committer refuse them explicitly instead of mislabeling them.
--
-- Additive and retry-safe: `ADD COLUMN` with no default does not rewrite rows,
-- and the CHECK constraint is dropped and re-added behind a guard rather than
-- assuming a name Postgres chose for itself.
--
-- Do not add BEGIN or COMMIT. scripts/db-migrate.ts wraps this file and its
-- version row in a single transaction.

ALTER TABLE pending_writes
  ADD COLUMN IF NOT EXISTS committed_at timestamptz,
  ADD COLUMN IF NOT EXISTS committed_record_id uuid;

-- The queue read is the hot path: same shape as idx_pending_queue, plus the new
-- predicate. The old index cannot serve it, because a committed auto draft is
-- still `receipt_id IS NULL AND rejected_at IS NULL` and would be scanned out.
CREATE INDEX IF NOT EXISTS idx_pending_queue_live
  ON pending_writes (tenant_id, risk_score DESC, created_at ASC)
  WHERE receipt_id IS NULL AND rejected_at IS NULL AND committed_at IS NULL;

-- The inline CHECK from 0002 has the auto-generated name below; IF NOT EXISTS
-- does not exist for ADD CONSTRAINT, so the whole block is guarded.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pending_writes_object_type_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%email%'
  ) THEN
    ALTER TABLE pending_writes DROP CONSTRAINT pending_writes_object_type_check;
    ALTER TABLE pending_writes ADD CONSTRAINT pending_writes_object_type_check
      CHECK (object_type IN ('customer', 'contact', 'followup', 'task',
                             'schedule', 'knowledge_document', 'email'));
  END IF;
END $$;

-- An auto write resolves to a row in one of the five business tables. No FK:
-- those tables are per-object, and the delete path for contacts/followups is
-- ON DELETE CASCADE, so a referential edge here would fight the spine's own
-- cascade rules. The column is provenance, not a constraint.
