-- migrations/0016_crum_prospects_hardening.sql
-- Hardening for the prospect pipeline: the updated_at touch trigger on
-- prospects and an index on every cascading FK path in the outreach tables.
--
-- 0015 was already applied when the trigger and indexes were written, and the
-- runner refuses to re-apply a migration whose bytes changed, so the delta
-- lives here instead of editing 0015.
--
-- Every statement is guarded so a partial apply can be retried, and there is no
-- BEGIN/COMMIT here — the runner wraps this file and its version record in one
-- transaction. The trigger uses the exact form 0002_crum_spine.sql uses for
-- every other table.

DROP TRIGGER IF EXISTS trg_prospects_touch ON prospects;
CREATE TRIGGER trg_prospects_touch BEFORE UPDATE ON prospects
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

-- Cascade paths: deleting a channel walks drafts by channel_id, deleting a
-- prospect or channel walks threads by both keys, deleting a thread walks its
-- replies by thread_id, and the merge-candidate pair key is
-- (tenant_id, left_prospect_id, right_prospect_id), so neither single-column
-- delete lookup is served by it.
CREATE INDEX IF NOT EXISTS outreach_drafts_channel_idx ON outreach_drafts (channel_id);
CREATE INDEX IF NOT EXISTS outreach_threads_prospect_idx ON outreach_threads (prospect_id);
CREATE INDEX IF NOT EXISTS outreach_threads_channel_idx ON outreach_threads (channel_id);
CREATE INDEX IF NOT EXISTS outreach_replies_thread_idx ON outreach_replies (thread_id);
CREATE INDEX IF NOT EXISTS prospect_merge_candidates_left_prospect_idx
  ON prospect_merge_candidates (left_prospect_id);
CREATE INDEX IF NOT EXISTS prospect_merge_candidates_right_prospect_idx
  ON prospect_merge_candidates (right_prospect_id);
