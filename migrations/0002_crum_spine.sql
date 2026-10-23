-- CRUM business spine. §5.1 business objects, §5.2 permission model,
-- §9.2 storage layout.
--
-- Applied by scripts/db-migrate.ts, which records the applied version in its
-- own version table and refuses to apply a file whose checksum changed
-- after it was applied.
--
-- Do not add BEGIN or COMMIT here. The runner wraps this file and its version
-- record in one transaction, so a failure leaves neither. A transaction inside
-- the file would commit the DDL before the version row is written.
--
-- Every table carries a non-nullable tenant_id. §5.2 requires
-- `tenant_id = :tenantId` on every single query without exception, and a
-- nullable column makes forgetting the predicate silently legal. NOT NULL turns
-- the omission into an insert failure during development instead of a
-- cross-tenant read in production.
--
-- Row-level security is deliberately not used. The application connects as the
-- table owner, so policies would not apply to it without also changing the
-- connection role, and §5.2 places the tenant predicate in the tool execute
-- layer where it is unit-testable. Revisit this if CRUM ever hands a direct
-- Postgres connection to a client.
--
-- gen_random_uuid() is built in from PostgreSQL 13. Supabase runs 15+ and CI runs
-- the pgvector/pgvector:pg17 image, so no extension is created here.
--
-- Everything is IF NOT EXISTS so a partially applied migration can be retried.

CREATE TABLE IF NOT EXISTS customers (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL,
  name             text        NOT NULL,
  company          text,
  email            text,
  phone            text,
  city             text,
  tags             text[]      NOT NULL DEFAULT '{}',
  -- §5.2: a record is visible when owner_id = :userId, or :userId is in
  -- team_member_ids, or :userRole = 'admin'. Both columns live here and only
  -- here; child records inherit visibility through their customer.
  owner_id         uuid        NOT NULL,
  team_member_ids  uuid[]      NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- No owner_id: a contact is always a child of a customer, so its visibility is
-- the customer's visibility. Duplicating the owner here would let the two
-- disagree, and a disagreement in a permission column is a leak.
CREATE TABLE IF NOT EXISTS contacts (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  customer_id  uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name         text        NOT NULL,
  role         text,
  email        text,
  phone        text,
  notes        text,
  is_primary   boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS followups (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  customer_id   uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  contact_id    uuid        REFERENCES contacts(id) ON DELETE SET NULL,
  type          text        NOT NULL CHECK (type IN ('call', 'email', 'meeting', 'visit')),
  status        text        NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled', 'completed', 'cancelled', 'missed')),
  scheduled_at  timestamptz NOT NULL,
  completed_at  timestamptz,
  notes         text,
  owner_id      uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT followups_completed_requires_time
    CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);

-- A task has a deadline and no start time. That absence is the enforcement of
-- §5.1's classification rule: if the agent is given a concrete range it must
-- create a schedule, and there is nowhere to put the range here.
CREATE TABLE IF NOT EXISTS tasks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  customer_id  uuid        REFERENCES customers(id) ON DELETE SET NULL,
  title        text        NOT NULL,
  description  text,
  deadline     timestamptz,
  priority     text        NOT NULL DEFAULT 'normal'
               CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status       text        NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  assigned_to  uuid,
  owner_id     uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- A schedule has a concrete range. §5.1.
CREATE TABLE IF NOT EXISTS schedules (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL,
  customer_id  uuid        REFERENCES customers(id) ON DELETE SET NULL,
  title        text        NOT NULL,
  start_time   timestamptz NOT NULL,
  end_time     timestamptz NOT NULL,
  location     text,
  attendees    text[]      NOT NULL DEFAULT '{}',
  status       text        NOT NULL DEFAULT 'confirmed'
               CHECK (status IN ('tentative', 'confirmed', 'cancelled')),
  owner_id     uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedules_end_after_start CHECK (end_time > start_time)
);

-- No vector column. Chunks and their embeddings arrive in Phase 4 (§9.3); this
-- table is the document registry the chunk table will reference.
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  title         text        NOT NULL,
  file_type     text        NOT NULL,
  -- §5.1: the hash dedupes re-uploads. Uniqueness is per tenant, so two tenants
  -- can hold the same file without one seeing the other's document.
  content_hash  text        NOT NULL,
  byte_size     integer,
  metadata      jsonb       NOT NULL DEFAULT '{}',
  status        text        NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  owner_id      uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_knowledge_document_hash UNIQUE (tenant_id, content_hash)
);

CREATE TABLE IF NOT EXISTS pending_writes (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL,
  run_id            text        NOT NULL,
  thread_id         text,
  object_type       text        NOT NULL
                    CHECK (object_type IN ('customer', 'contact', 'followup', 'task',
                                           'schedule', 'knowledge_document')),
  operation         text        NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  target_id         uuid,
  payload           jsonb       NOT NULL,
  risk_score        integer     NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  gate              text        NOT NULL CHECK (gate IN ('auto', 'approval', 'refuse')),
  -- Not a foreign key yet: audit_receipts references this table, so the reverse
  -- edge is added by the guarded ALTER at the bottom of this file.
  receipt_id        uuid,
  rejected_at       timestamptz,
  rejection_reason  text,
  requested_by      uuid        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- §10.3.3: a staged draft expires so an approval token cannot be replayed
  -- against a business state that has since changed.
  expires_at        timestamptz NOT NULL,
  CONSTRAINT pending_writes_update_needs_target
    CHECK (operation = 'create' OR target_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS audit_receipts (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL,
  pending_write_id     uuid        NOT NULL REFERENCES pending_writes(id) ON DELETE CASCADE,
  run_id               text        NOT NULL,
  -- HMAC over the draft and the runId, signed with APPROVAL_HMAC_SECRET. §12.3.
  signature            text        NOT NULL,
  committed_record_id  uuid,
  approved_by          uuid        NOT NULL,
  decision             text        NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason               text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- One decision per staged draft, forever. A replayed approval token cannot
  -- produce a second commit, and a draft cannot be rejected and then approved.
  CONSTRAINT uq_receipts_draft UNIQUE (pending_write_id)
);

-- Written by §4.6.1's refuse path. A refusal is a work item for a human, not a
-- dropped message: the agent says no and someone has to be told.
CREATE TABLE IF NOT EXISTS human_tasks (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL,
  run_id        text        NOT NULL,
  thread_id     text,
  kind          text        NOT NULL CHECK (kind IN ('refusal', 'escalation', 'review')),
  title         text        NOT NULL,
  body          text,
  tool_name     text,
  risk_score    integer     NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 100),
  status        text        NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  assigned_to   uuid,
  requested_by  uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_customers_tenant_owner ON customers (tenant_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_customers_tenant_name  ON customers (tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_customers_tags         ON customers USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_customers_team          ON customers USING gin (team_member_ids);
CREATE INDEX IF NOT EXISTS idx_contacts_customer      ON contacts (customer_id);
CREATE INDEX IF NOT EXISTS idx_followups_queue        ON followups (tenant_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline         ON tasks (tenant_id, status, deadline);
CREATE INDEX IF NOT EXISTS idx_schedules_start        ON schedules (tenant_id, start_time);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_state   ON knowledge_documents (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_run            ON pending_writes (tenant_id, run_id);
CREATE INDEX IF NOT EXISTS idx_pending_expiry         ON pending_writes (expires_at)
  WHERE receipt_id IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_receipts_run           ON audit_receipts (tenant_id, run_id);
CREATE INDEX IF NOT EXISTS idx_human_tasks_open       ON human_tasks (tenant_id, status, created_at DESC);

-- The approval queue. §12.4: highest risk first, oldest first within a risk
-- level, and only drafts that are still undecided. The partial predicate is what
-- keeps this index small; a decided draft leaves it without a DELETE.
CREATE INDEX IF NOT EXISTS idx_pending_queue ON pending_writes (tenant_id, risk_score DESC, created_at ASC)
  WHERE receipt_id IS NULL AND rejected_at IS NULL;

CREATE OR REPLACE FUNCTION crum_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customers_touch ON customers;
CREATE TRIGGER trg_customers_touch BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

DROP TRIGGER IF EXISTS trg_contacts_touch ON contacts;
CREATE TRIGGER trg_contacts_touch BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

DROP TRIGGER IF EXISTS trg_followups_touch ON followups;
CREATE TRIGGER trg_followups_touch BEFORE UPDATE ON followups
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

DROP TRIGGER IF EXISTS trg_tasks_touch ON tasks;
CREATE TRIGGER trg_tasks_touch BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

DROP TRIGGER IF EXISTS trg_schedules_touch ON schedules;
CREATE TRIGGER trg_schedules_touch BEFORE UPDATE ON schedules
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

DROP TRIGGER IF EXISTS trg_knowledge_documents_touch ON knowledge_documents;
CREATE TRIGGER trg_knowledge_documents_touch BEFORE UPDATE ON knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

-- The reverse edge of the pending_writes / audit_receipts cycle. ALTER TABLE has
-- no ADD CONSTRAINT IF NOT EXISTS, so the guard is explicit.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_pending_writes_receipt'
  ) THEN
    ALTER TABLE pending_writes
      ADD CONSTRAINT fk_pending_writes_receipt
      FOREIGN KEY (receipt_id) REFERENCES audit_receipts(id) ON DELETE SET NULL;
  END IF;
END $$;
