-- CRM business-document intake. Phase 1 of the Document Intake Pipeline.
--
-- Version 0009: scripts/db-migrate.ts derives the recorded version from the
-- 4-digit filename prefix alone and crum_schema_migrations.version is a PRIMARY
-- KEY, so this file must not reuse 0001..0008. It is the next free number.
--
-- Do not add BEGIN or COMMIT here; the runner wraps this file and its version
-- record in one transaction.
--
-- These tables are the STRUCTURED counterpart to knowledge_documents (0002), which
-- stays the generic RAG registry. A business doc's rows here make its numbers
-- aggregatable (invoice totals, contract value) — the whole point over RAG — while
-- its content_text is still embedded into the same vector index for prose
-- questions. content_text is stored here (knowledge_documents stores only a hash),
-- which is why a business doc can be re-indexed and a plain knowledge upload
-- cannot.
--
-- Every table carries a non-nullable tenant_id and the tenant predicate is applied
-- in the query layer (§5.2). Extraction never mutates a CRM record: customer_id is
-- a read-only resolution link, nullable when the vendor/counterparty is not a
-- known customer.

-- The document registry: one row per ingested bill or contract, of any kind.
CREATE TABLE IF NOT EXISTS documents (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL,
  owner_id       uuid        NOT NULL,
  kind           text        NOT NULL
               CHECK (kind IN ('invoice', 'contract', 'other')),
  title          text        NOT NULL,
  source         text        NOT NULL DEFAULT 'upload'
               CHECK (source IN ('upload', 'email')),
  -- Email message id / attachment id when source = 'email'; null for uploads.
  source_ref     text,
  -- sha256 of the extracted text, per-tenant dedup key (§5.1).
  content_hash   text        NOT NULL,
  content_text   text        NOT NULL,
  mime           text        NOT NULL DEFAULT '',
  status         text        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'processing', 'ready', 'needs_review', 'failed')),
  -- Model self-report blended with required-field coverage; null before extraction.
  confidence     numeric(4, 3),
  -- Read-only entity resolution. Not a mutation: links a doc to a known customer.
  customer_id    uuid        REFERENCES customers(id) ON DELETE SET NULL,
  -- Full model output plus provenance (per-field confidence, retries).
  raw_extract    jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_document_hash UNIQUE (tenant_id, content_hash)
);

-- Invoice header. document_id is the PK: exactly one invoice row per document,
-- and ON DELETE CASCADE retires it with the parent.
CREATE TABLE IF NOT EXISTS invoices (
  document_id    uuid        PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  vendor_name    text,
  vendor_email   text,
  invoice_number text,
  invoice_date   date,
  due_date       date,
  currency       text,
  subtotal       numeric,
  tax            numeric,
  total          numeric
);

-- Invoice line items. Aggregatable amounts, not prose.
CREATE TABLE IF NOT EXISTS invoice_lines (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    uuid        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  description    text,
  quantity       numeric,
  unit_price     numeric,
  amount         numeric,
  currency       text
);

-- Contract header. Same one-row-per-document pattern as invoices.
CREATE TABLE IF NOT EXISTS contracts (
  document_id         uuid        PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  counterparty        text,
  counterparty_email  text,
  effective_date      date,
  expiry_date         date,
  term_months         integer,
  contract_value      numeric,
  currency            text,
  auto_renewal        boolean,
  renewal_notice_days integer
);

-- Extracted contract clauses, with character offsets into content_text so a
-- reader can cite the source passage.
CREATE TABLE IF NOT EXISTS contract_terms (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    uuid        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  clause_type    text,
  title          text,
  text           text,
  start_offset   integer,
  end_offset     integer
);

CREATE INDEX IF NOT EXISTS idx_documents_tenant_kind   ON documents (tenant_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_documents_customer       ON documents (customer_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_document   ON invoice_lines (document_id);
CREATE INDEX IF NOT EXISTS idx_contract_terms_document  ON contract_terms (document_id);

DROP TRIGGER IF EXISTS trg_documents_touch ON documents;
CREATE TRIGGER trg_documents_touch BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();
