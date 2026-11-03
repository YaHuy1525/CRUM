-- Phase 1: Field-level audit trails and per-field confidence
-- Migration 0023: adds audit logging via triggers and field_confidence JSONB columns

-- 1. Create audit table
CREATE TABLE IF NOT EXISTS document_field_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  table_name text NOT NULL,
  field_name text NOT NULL,
  row_id uuid,
  action text NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  old_value jsonb,
  new_value jsonb,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  change_source text NOT NULL DEFAULT 'extraction'
    CHECK (change_source IN ('extraction', 'manual_correction', 're-parse', 'import', 'system')),
  reason text
);

-- 2. Create indexes
CREATE INDEX IF NOT EXISTS idx_field_audit_document ON document_field_audit (document_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_audit_tenant ON document_field_audit (tenant_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_audit_table_field ON document_field_audit (table_name, field_name);

-- 3. Create trigger function
CREATE OR REPLACE FUNCTION log_field_changes()
RETURNS TRIGGER AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
  field_name text;
  old_val jsonb;
  new_val jsonb;
  tenant uuid;
  doc_id uuid;
  user_id uuid;
  source text;
BEGIN
  IF TG_TABLE_NAME IN ('invoices', 'contracts') THEN
    doc_id := COALESCE(NEW.document_id, OLD.document_id);
    SELECT d.tenant_id INTO tenant FROM documents d WHERE d.id = doc_id;
  ELSE
    tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
    doc_id := COALESCE(NEW.document_id, OLD.document_id);
  END IF;
  
  user_id := current_setting('app.current_user_id', true)::uuid;
  source := current_setting('app.change_source', true);
  IF source IS NULL THEN source := 'extraction'; END IF;
  
  old_row := to_jsonb(OLD);
  new_row := to_jsonb(NEW);
  
  IF TG_OP = 'INSERT' THEN
    FOR field_name IN SELECT jsonb_object_keys(new_row) LOOP
      IF field_name NOT IN ('id', 'document_id', 'tenant_id', 'created_at', 'updated_at', 'field_confidence') THEN
        new_val := new_row[field_name];
        IF new_val IS NOT NULL AND new_val != 'null'::jsonb THEN
          INSERT INTO document_field_audit (document_id, tenant_id, table_name, field_name, row_id, action, old_value, new_value, changed_by, change_source)
          VALUES (doc_id, tenant, TG_TABLE_NAME, field_name, COALESCE(NEW.id, NEW.document_id), 'insert', NULL, new_val, user_id, source);
        END IF;
      END IF;
    END LOOP;
  ELSIF TG_OP = 'UPDATE' THEN
    FOR field_name IN SELECT jsonb_object_keys(new_row) LOOP
      IF field_name NOT IN ('id', 'document_id', 'tenant_id', 'created_at', 'updated_at', 'field_confidence') THEN
        old_val := old_row[field_name];
        new_val := new_row[field_name];
        IF old_val IS DISTINCT FROM new_val THEN
          INSERT INTO document_field_audit (document_id, tenant_id, table_name, field_name, row_id, action, old_value, new_value, changed_by, change_source)
          VALUES (doc_id, tenant, TG_TABLE_NAME, field_name, COALESCE(NEW.id, NEW.document_id), 'update', old_val, new_val, user_id, source);
        END IF;
      END IF;
    END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    FOR field_name IN SELECT jsonb_object_keys(old_row) LOOP
      IF field_name NOT IN ('id', 'document_id', 'tenant_id', 'created_at', 'updated_at', 'field_confidence') THEN
        old_val := old_row[field_name];
        IF old_val IS NOT NULL AND old_val != 'null'::jsonb THEN
          INSERT INTO document_field_audit (document_id, tenant_id, table_name, field_name, row_id, action, old_value, new_value, changed_by, change_source)
          VALUES (doc_id, tenant, TG_TABLE_NAME, field_name, COALESCE(OLD.id, OLD.document_id), 'delete', old_val, NULL, user_id, source);
        END IF;
      END IF;
    END LOOP;
  END IF;
  
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- 4. Attach triggers
DROP TRIGGER IF EXISTS trg_invoices_audit ON invoices;
CREATE TRIGGER trg_invoices_audit AFTER INSERT OR UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION log_field_changes();

DROP TRIGGER IF EXISTS trg_contracts_audit ON contracts;
CREATE TRIGGER trg_contracts_audit AFTER INSERT OR UPDATE OR DELETE ON contracts FOR EACH ROW EXECUTE FUNCTION log_field_changes();

DROP TRIGGER IF EXISTS trg_invoice_lines_audit ON invoice_lines;
CREATE TRIGGER trg_invoice_lines_audit AFTER INSERT OR UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION log_field_changes();

DROP TRIGGER IF EXISTS trg_contract_terms_audit ON contract_terms;
CREATE TRIGGER trg_contract_terms_audit AFTER INSERT OR UPDATE OR DELETE ON contract_terms FOR EACH ROW EXECUTE FUNCTION log_field_changes();

-- 5. Add field_confidence columns
ALTER TABLE documents ADD COLUMN IF NOT EXISTS field_confidence jsonb;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS field_confidence jsonb;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS field_confidence jsonb;
ALTER TABLE invoice_lines ADD COLUMN IF NOT EXISTS field_confidence jsonb;
ALTER TABLE contract_terms ADD COLUMN IF NOT EXISTS field_confidence jsonb;
