-- migrations/0017_crum_prospect_merge.sql
-- Merge resolution writes through pending_writes like every other approval-class
-- tool, and 0015's check constraint lists the object types it will accept. A
-- resolved duplicate pair is not a row update — it repoints four child tables,
-- folds consent and deletes the duplicate — so it needs an object type of its
-- own rather than overloading 'prospect'.
--
-- Same conventions as 0015/0016: DROP before ADD so a partial apply retries, and
-- no BEGIN/COMMIT here — the runner wraps this file and its version record in
-- one transaction.

ALTER TABLE pending_writes DROP CONSTRAINT IF EXISTS pending_writes_object_type_check;
ALTER TABLE pending_writes ADD CONSTRAINT pending_writes_object_type_check
  CHECK (object_type IN ('customer','contact','followup','task','schedule',
                         'knowledge_document','email',
                         'prospect','prospect_channel','outreach_draft','outreach_send',
                         'prospect_merge'));
