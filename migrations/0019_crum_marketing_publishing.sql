-- migrations/0019_crum_marketing_publishing.sql
-- AI marketing team, slice 2: the publishing widening and the inbound lead lane.
-- Spec: docs/superpowers/specs/2026-10-31-marketing-team-slice-2-design.md section 3.4.
--
-- Drop-and-readd for every CHECK, the way 0017 and 0018 do it: Postgres has no
-- ALTER CONSTRAINT, and a partial re-declare would leave the old list in place.

ALTER TABLE marketing_artifacts DROP CONSTRAINT IF EXISTS marketing_artifacts_kind_check;
-- Slot-as-kind: the file name is a constant in CRUM, so the model never names a
-- path. Each uploaded file is its own kind, and two rows of one kind is an
-- ambiguity the publisher refuses rather than resolves.
ALTER TABLE marketing_artifacts ADD CONSTRAINT marketing_artifacts_kind_check
  CHECK (kind IN ('image','page_html','form_spec','campaign_spec','script','report','thank_you_html'));

ALTER TABLE marketing_actions DROP CONSTRAINT IF EXISTS marketing_actions_action_check;
-- promote_page is declared but never derived: a plan asks for a page, only a
-- human asks for it to go live.
ALTER TABLE marketing_actions ADD CONSTRAINT marketing_actions_action_check
  CHECK (action IN ('publish_page','unpublish_page','create_campaign','set_campaign_status','promote_page'));

-- external_id is one column and publishing answers two things worth keeping.
-- Spec section 3.2: the parent spec promised a recorded response with nowhere to
-- record it.
ALTER TABLE marketing_actions ADD COLUMN IF NOT EXISTS result jsonb;

-- Minted at save, stamped into the page before its bytes are hashed: a token
-- injected after approval would mean publishing bytes nobody reviewed.
ALTER TABLE marketing_bundles ADD COLUMN IF NOT EXISTS lead_token text;

ALTER TABLE pending_writes DROP CONSTRAINT IF EXISTS pending_writes_object_type_check;
ALTER TABLE pending_writes ADD CONSTRAINT pending_writes_object_type_check
  CHECK (object_type IN ('customer','contact','followup','task','schedule',
                         'knowledge_document','email',
                         'prospect','prospect_channel','outreach_draft','outreach_send',
                         'prospect_merge',
                         'marketing_bundle','marketing_stage','marketing_promote','marketing_retry'));

-- Deviation from the parent spec section 8, which promised no new table. There
-- is nowhere on prospects to put a budget bucket, and the core spine is not the
-- place to add one. This is also the only row set slice 3's weekly report counts.
CREATE TABLE IF NOT EXISTS marketing_leads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  bundle_id        uuid NOT NULL REFERENCES marketing_bundles(id) ON DELETE CASCADE,
  prospect_id      uuid,
  email            text NOT NULL,
  email_normalized text NOT NULL,
  country          text NOT NULL CHECK (country IN ('AU','VN')),
  budget_bucket    text NOT NULL
                   CHECK (budget_bucket IN ('under_500','500_to_2k','2k_plus','not_sure')),
  goal             text NOT NULL,
  source_url       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT marketing_leads_tenant_bundle_email_key
    UNIQUE (tenant_id, bundle_id, email_normalized),
  CONSTRAINT marketing_leads_goal_length CHECK (char_length(goal) BETWEEN 1 AND 500)
);

CREATE INDEX IF NOT EXISTS marketing_leads_bundle_created_idx
  ON marketing_leads (bundle_id, created_at);
