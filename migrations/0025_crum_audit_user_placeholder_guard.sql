-- Phase 2: audit trigger placeholder guard.
-- Migration 0025: the single delta against 0023's log_field_changes() body is that
-- current_setting('app.current_user_id', true)::uuid becomes
-- NULLIF(current_setting('app.current_user_id', true), '')::uuid.
--
-- On a session-mode backend that has ever carried a correction, Postgres leaves the
-- custom GUC holding the placeholder '' rather than NULL after a RESET. The unguarded
-- ''::uuid cast then throws "invalid input syntax for type uuid: """, so any
-- contextless write to an audited table on that backend fails instead of auditing
-- with a NULL actor. NULLIF turns the placeholder back into SQL NULL before the cast.
--
-- Do not add BEGIN or COMMIT here; scripts/db-migrate.ts wraps this file and its
-- version record in one transaction.

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
  row_id uuid;
  user_id uuid;
  source text;
BEGIN
  IF TG_TABLE_NAME IN ('invoices', 'contracts') THEN
    doc_id := COALESCE(NEW.document_id, OLD.document_id);
    row_id := COALESCE(NEW.document_id, OLD.document_id);
    SELECT d.tenant_id INTO tenant FROM documents d WHERE d.id = doc_id;
  ELSE
    tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
    doc_id := COALESCE(NEW.document_id, OLD.document_id);
    row_id := COALESCE(NEW.id, OLD.id);
  END IF;

  -- During CASCADE deletes the parent document row may already be gone,
  -- so tenant can be NULL.  Skip audit logging in that case.
  IF tenant IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  user_id := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
  source := current_setting('app.change_source', true);
  IF source IS NULL OR source = '' THEN source := 'extraction'; END IF;

  old_row := to_jsonb(OLD);
  new_row := to_jsonb(NEW);

  IF TG_OP = 'INSERT' THEN
    FOR field_name IN SELECT jsonb_object_keys(new_row) LOOP
      IF field_name NOT IN ('id', 'document_id', 'tenant_id', 'created_at', 'updated_at', 'field_confidence') THEN
        new_val := new_row[field_name];
        IF new_val IS NOT NULL AND new_val != 'null'::jsonb THEN
          INSERT INTO document_field_audit (document_id, tenant_id, table_name, field_name, row_id, action, old_value, new_value, changed_by, change_source)
          VALUES (doc_id, tenant, TG_TABLE_NAME, field_name, row_id, 'insert', NULL, new_val, user_id, source);
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
          VALUES (doc_id, tenant, TG_TABLE_NAME, field_name, row_id, 'update', old_val, new_val, user_id, source);
        END IF;
      END IF;
    END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    FOR field_name IN SELECT jsonb_object_keys(old_row) LOOP
      IF field_name NOT IN ('id', 'document_id', 'tenant_id', 'created_at', 'updated_at', 'field_confidence') THEN
        old_val := old_row[field_name];
        IF old_val IS NOT NULL AND old_val != 'null'::jsonb THEN
          INSERT INTO document_field_audit (document_id, tenant_id, table_name, field_name, row_id, action, old_value, new_value, changed_by, change_source)
          VALUES (doc_id, tenant, TG_TABLE_NAME, field_name, row_id, 'delete', old_val, NULL, user_id, source);
        END IF;
      END IF;
    END LOOP;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
