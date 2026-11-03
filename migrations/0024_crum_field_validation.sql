-- Phase 2: validation findings for extracted business documents.
-- Migration 0024: one row per live finding, so analytics group by rule and by field
-- and export selects a date slice. Phase 1's document_field_audit records what
-- changed; this records what is wrong and whether a human overrode it.
--
-- Do not add BEGIN or COMMIT here; scripts/db-migrate.ts wraps this file and its
-- version record in one transaction.

CREATE TABLE IF NOT EXISTS document_validation (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      uuid        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- Written from the caller's identity, never copied from the document row, so a
  -- mismatch is caught by the tenant predicate instead of inherited silently.
  tenant_id        uuid        NOT NULL,
  ruleset_version  text        NOT NULL,
  severity         text        NOT NULL CHECK (severity IN ('error', 'warning')),
  rule_id          text        NOT NULL,
  field_name       text        NOT NULL,
  message          text        NOT NULL,
  status           text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waived')),
  waived_by        uuid,
  waived_at        timestamptz,
  waiver_reason    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- One live finding per rule per field per document.
  CONSTRAINT uq_validation_slot UNIQUE (document_id, rule_id, field_name)
);

CREATE INDEX IF NOT EXISTS idx_validation_doc_status  ON document_validation (document_id, status);
CREATE INDEX IF NOT EXISTS idx_validation_tenant_rule ON document_validation (tenant_id, rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_validation_tenant_field ON document_validation (tenant_id, field_name, created_at DESC);
