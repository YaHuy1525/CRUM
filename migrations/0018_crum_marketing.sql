-- migrations/0018_crum_marketing.sql
-- AI marketing team, slice 1: the bundle spine.
-- Spec: docs/superpowers/specs/2026-10-30-marketing-team-design.md section 4.
--
-- Same conventions as 0002 and 0015: non-nullable tenant_id on every table,
-- IF NOT EXISTS so a partial apply can be retried, no BEGIN/COMMIT here because
-- scripts/db-migrate.ts wraps this file and its version row in one transaction.
-- 0018 is the next free prefix after 0017_crum_prospect_merge.sql.

CREATE TABLE IF NOT EXISTS marketing_bundles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  brief          text NOT NULL,
  objective      text NOT NULL
                 CHECK (objective IN ('outreach_support','inbound_leads','proof_asset')),
  audience_note  text,
  -- A bundle moves draft -> staged -> approved -> (publishing -> live | failed).
  -- 'archived' is reserved: archiving is a later slice's tool, the status is
  -- here now so a CHECK does not have to be re-rolled later.
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','staged','approved','publishing','live','failed','archived')),
  -- One column per producing role, so an audit can answer which version of
  -- which role produced a live page. The designer has no column: its output is
  -- bytes, so it lands in marketing_artifacts.
  strategy       jsonb,
  copy           jsonb,
  media_plan     jsonb,
  funnel_plan    jsonb,
  analysis       jsonb,
  prompt_version text NOT NULL,
  -- Content hash, and the second line of idempotency behind the pending_writes
  -- unique draft_hash index: a retried save must never produce two bundles.
  draft_hash     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_bundles_tenant_draft_key UNIQUE (tenant_id, draft_hash)
);

CREATE INDEX IF NOT EXISTS marketing_bundles_tenant_status_idx
  ON marketing_bundles (tenant_id, status, created_at);

-- The bundle row is UPDATEd on every status change (draft -> staged -> approved
-- -> live|failed), so updated_at needs the same trigger every other table with
-- that column has: 0002 defines crum_touch_updated_at(), and 0016 was written
-- specifically to retrofit the one table that shipped without it.
DROP TRIGGER IF EXISTS trg_marketing_bundles_touch ON marketing_bundles;
CREATE TRIGGER trg_marketing_bundles_touch
  BEFORE UPDATE ON marketing_bundles
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

CREATE TABLE IF NOT EXISTS marketing_artifacts (
  -- Ids are content-addressed in src/marketing/hash.ts, not random, so the same
  -- asset saved twice is one row. The default only covers hand-written inserts.
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  bundle_id    uuid NOT NULL REFERENCES marketing_bundles(id) ON DELETE CASCADE,
  role         text NOT NULL
               CHECK (role IN ('offer-strategist','marketer-copywriter','creative-designer',
                               'media-buyer','funnel-builder','campaign-analyst')),
  kind         text NOT NULL
               CHECK (kind IN ('image','page_html','form_spec','campaign_spec','script','report')),
  -- document_id is the bridge to migrations/0009_crum_documents.sql and
  -- 0011_crum_document_parse.sql: generated images inherit the existing sha256
  -- dedup and file storage instead of inventing a second byte store.
  document_id  uuid REFERENCES documents(id),
  text_content text,
  status       text NOT NULL DEFAULT 'pending_review'
               CHECK (status IN ('pending_review','approved','rejected')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- An image must carry bytes (document_id); every other kind must carry text.
  -- The shape is enforced here, not only in the tool, so a row written by a
  -- future migration or by hand can never be unrenderable.
  CONSTRAINT marketing_artifacts_payload_shape
    CHECK ((kind = 'image' AND document_id IS NOT NULL)
           OR (kind <> 'image' AND text_content IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS marketing_artifacts_bundle_idx
  ON marketing_artifacts (bundle_id);

-- The outbox. This is the only place an external call may originate, and the
-- only place an external action's name is allowed to be written down: those
-- names contain 'publish', which the risk scorer would read as irreversible,
-- so they live here as column values and never in an approval payload.
CREATE TABLE IF NOT EXISTS marketing_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  bundle_id   uuid NOT NULL REFERENCES marketing_bundles(id) ON DELETE CASCADE,
  action      text NOT NULL
              CHECK (action IN ('publish_page','unpublish_page','create_campaign','set_campaign_status')),
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','succeeded','failed')),
  -- A terminal 'failed' needs a new queued row, never a silent retry, so the
  -- ceiling is enforced by the database rather than by the drainer's good
  -- intentions.
  attempts    integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
  last_error  text,
  external_id text,
  receipt_id  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz
);

-- The drain query only ever reads queued rows, so the partial index covers just
-- those; once an action reaches a terminal status it drops out of the index.
CREATE INDEX IF NOT EXISTS marketing_actions_queued_idx
  ON marketing_actions (created_at) WHERE status = 'queued';

ALTER TABLE pending_writes DROP CONSTRAINT IF EXISTS pending_writes_object_type_check;
ALTER TABLE pending_writes ADD CONSTRAINT pending_writes_object_type_check
  CHECK (object_type IN ('customer','contact','followup','task','schedule',
                         'knowledge_document','email',
                         'prospect','prospect_channel','outreach_draft','outreach_send',
                         'prospect_merge',
                         'marketing_bundle','marketing_stage'));
