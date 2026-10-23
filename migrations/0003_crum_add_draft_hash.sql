-- migrations/0003_add_draft_hash.sql
-- Adds the draft_hash idempotency column to pending_writes.
-- §12.1: the unique index is the second line of defence behind
-- outputValidation: 'warn' — together they prevent duplicate writes.
--
-- The hash is computed by the application from the payload and stored
-- explicitly so the unique index can reference it.

ALTER TABLE pending_writes
  ADD COLUMN IF NOT EXISTS draft_hash text;

-- Backfill existing rows (should be none in a fresh deployment).
UPDATE pending_writes SET draft_hash = encode(sha256(payload::text::bytea), 'hex')
  WHERE draft_hash IS NULL;

-- Make the column non-null going forward.
ALTER TABLE pending_writes
  ALTER COLUMN draft_hash SET NOT NULL,
  ALTER COLUMN draft_hash SET DEFAULT encode(sha256(payload::text::bytea), 'hex');

-- The idempotency guard: same tenant + same draft hash = same write.
-- Partial: only undecided drafts participate (a decided draft cannot be replayed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_draft_hash
  ON pending_writes (tenant_id, draft_hash)
  WHERE receipt_id IS NULL AND rejected_at IS NULL;
