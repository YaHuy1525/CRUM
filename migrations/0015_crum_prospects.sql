-- migrations/0015_crum_prospects.sql
-- Prospect pipeline. Spec: docs/superpowers/specs/2026-10-30-prospect-pipeline-design.md
--
-- Version 0015: the plan named this 0013, but 0013_crum_sponsorship.sql and
-- 0014_crum_billing.sql were applied first. scripts/db-migrate.ts derives the
-- recorded version from the 4-digit prefix alone and crum_schema_migrations
-- keys on it, so reusing 0013 would make db:migrate fail for every environment
-- (see 9ee916d). This file therefore takes the next free number.
--
-- Same conventions as 0002/0013: non-nullable tenant_id on every table,
-- IF NOT EXISTS so a partial apply can be retried, and no BEGIN/COMMIT here —
-- the runner wraps this file and its version record in one transaction.

CREATE TABLE IF NOT EXISTS prospects (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL,
  name                    text NOT NULL,
  name_normalized         text NOT NULL,
  country                 text NOT NULL CHECK (country IN ('AU', 'VN')),
  city                    text,
  category                text,
  status                  text NOT NULL DEFAULT 'new'
                          CHECK (status IN ('new','working','contacted','replied','won','lost','nurture')),
  converted_customer_id   uuid REFERENCES customers(id),
  owner_id                uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prospects_tenant_name_idx ON prospects (tenant_id, name_normalized);

CREATE TABLE IF NOT EXISTS prospect_channels (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  prospect_id           uuid NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  platform              text NOT NULL
                        CHECK (platform IN ('instagram','linkedin','facebook','tiktok','youtube','shopee','website','email')),
  handle                text NOT NULL,
  handle_normalized     text NOT NULL,
  profile_url           text NOT NULL,
  audience_count        integer,
  audience_basis        text NOT NULL DEFAULT 'unknown'
                        CHECK (audience_basis IN ('followers','linkedin_connections','students','clients','unknown')),
  audience_confidence   text NOT NULL DEFAULT 'unverified'
                        CHECK (audience_confidence IN ('exact','approximate','unverified')),
  observed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prospect_channels_tenant_platform_handle_key
    UNIQUE (tenant_id, platform, handle_normalized)
);

CREATE INDEX IF NOT EXISTS prospect_channels_prospect_idx ON prospect_channels (prospect_id);

CREATE TABLE IF NOT EXISTS prospect_snapshots (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  prospect_id         uuid NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  what_they_sell      text,
  price_min_minor     integer,
  price_max_minor     integer,
  currency            char(3),
  price_visible       boolean NOT NULL DEFAULT false,
  has_website         boolean NOT NULL DEFAULT false,
  has_lead_magnet     boolean NOT NULL DEFAULT false,
  has_email_capture   boolean NOT NULL DEFAULT false,
  has_funnel          boolean NOT NULL DEFAULT false,
  weakness_signals    text[] NOT NULL DEFAULT '{}',
  source_url          text,
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  extractor_version   text NOT NULL
);

CREATE INDEX IF NOT EXISTS prospect_snapshots_prospect_idx
  ON prospect_snapshots (prospect_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS prospect_scores (
  prospect_id           uuid PRIMARY KEY REFERENCES prospects(id) ON DELETE CASCADE,
  tenant_id             uuid NOT NULL,
  audience_score        numeric(4,3) NOT NULL,
  monetisation_score    numeric(4,3) NOT NULL,
  funnel_gap_score      numeric(4,3) NOT NULL,
  reachability_score    numeric(4,3) NOT NULL,
  total                 numeric(5,2) NOT NULL,
  band                  text NOT NULL CHECK (band IN ('micro','small','mid','big')),
  weights_version       text NOT NULL,
  computed_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outreach_drafts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  prospect_id            uuid NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  channel_id             uuid NOT NULL REFERENCES prospect_channels(id) ON DELETE CASCADE,
  stage                  text NOT NULL CHECK (stage IN ('first_touch','followup_1','followup_2')),
  body                   text NOT NULL,
  language               text NOT NULL CHECK (language IN ('en','vi')),
  angle                  text NOT NULL CHECK (angle IN ('funnel_gap','audience_leak','offer_productisation','proof')),
  status                 text NOT NULL DEFAULT 'drafted'
                         CHECK (status IN ('drafted','approved','sent','skipped','snoozed','failed')),
  evidence_snapshot_id   uuid REFERENCES prospect_snapshots(id),
  prompt_version         text NOT NULL,
  draft_hash             text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  decided_at             timestamptz,
  sent_at                timestamptz,
  CONSTRAINT outreach_drafts_tenant_draft_hash_key UNIQUE (tenant_id, draft_hash)
);

CREATE INDEX IF NOT EXISTS outreach_drafts_prospect_idx ON outreach_drafts (prospect_id, stage);

CREATE TABLE IF NOT EXISTS outreach_threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  prospect_id     uuid NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL REFERENCES prospect_channels(id) ON DELETE CASCADE,
  subject         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outreach_replies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  thread_id             uuid NOT NULL REFERENCES outreach_threads(id) ON DELETE CASCADE,
  external_message_id   text NOT NULL,
  received_at           timestamptz NOT NULL,
  body                  text NOT NULL,
  classification        text NOT NULL CHECK (classification IN
                        ('interested','not_now','not_fit','price_question','proof_request','opt_out','auto_reply','other')),
  handled_by            text NOT NULL CHECK (handled_by IN ('rule','model','human')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outreach_replies_tenant_external_key UNIQUE (tenant_id, external_message_id)
);

CREATE TABLE IF NOT EXISTS prospect_consents (
  prospect_id   uuid PRIMARY KEY REFERENCES prospects(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL,
  basis         text NOT NULL CHECK (basis IN ('inbound_reply','opt_in','manual_override')),
  source        text NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

-- The batch row is this slice's audit record for an import, in place of a
-- signed receipt, so it records who ran the import. Nullable for a background
-- run with no logged-in user; same bare-uuid pattern as documents.owner_id.
CREATE TABLE IF NOT EXISTS prospect_import_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  requested_by    uuid,
  file_hash       text NOT NULL,
  file_name       text NOT NULL,
  rows_in         integer NOT NULL,
  rows_new        integer NOT NULL,
  rows_duplicate  integer NOT NULL,
  rows_candidate  integer NOT NULL,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prospect_import_batches_tenant_file_key UNIQUE (tenant_id, file_hash)
);

CREATE TABLE IF NOT EXISTS prospect_merge_candidates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  left_prospect_id    uuid NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  right_prospect_id   uuid NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  reason              text NOT NULL,
  similarity          numeric(4,3) NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','merged','dismissed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prospect_merge_candidates_pair_key
    UNIQUE (tenant_id, left_prospect_id, right_prospect_id)
);

-- pending_writes currently allows six object types. The prospect lane needs four more.
ALTER TABLE pending_writes DROP CONSTRAINT IF EXISTS pending_writes_object_type_check;
ALTER TABLE pending_writes ADD CONSTRAINT pending_writes_object_type_check
  CHECK (object_type IN ('customer','contact','followup','task','schedule',
                         'knowledge_document','email',
                         'prospect','prospect_channel','outreach_draft','outreach_send'));
