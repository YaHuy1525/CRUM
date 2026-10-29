-- Video revenue tracking: channels, OAuth tokens, daily earnings, and weekly
-- audience metrics for YouTube, TikTok, Instagram, and Twitch.
--
-- Version 0012: next free number after 0011; scripts/db-migrate.ts keys
-- crum_schema_migrations on the 4-digit prefix, so 0001..0011 are taken.
--
-- Do not add BEGIN or COMMIT here; the runner wraps this file and its version
-- record in one transaction.
--
-- Four tables:
--   * oauth_tokens   -- encrypted per-platform access/refresh tokens. Created
--                      first so video_channels can reference it.
--   * video_channels -- one row per platform channel a tenant tracks. Links to
--                      an optional customer and contact for CRM context, and to
--                      the oauth_tokens row that authorises API calls.
--   * video_earnings -- daily revenue snapshots per channel. One row per
--                      (channel, date); re-syncs upsert into the same row.
--   * video_audience_metrics -- weekly subscriber / view / engagement roll-ups.
--                      One row per (channel, week_start).
--
-- Same conventions as 0002/0009: non-nullable tenant_id on every table, tenant
-- predicate applied in the query layer, IF NOT EXISTS everywhere so a partial
-- apply can be retried.

-- Encrypted OAuth tokens. Stored before video_channels so the FK from
-- video_channels.oauth_token_id can be declared inline.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid        NOT NULL,
  platform                varchar(50) NOT NULL,
  access_token_encrypted  bytea       NOT NULL,
  refresh_token_encrypted bytea,
  expires_at              timestamptz,
  scope                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_tenant_platform
  ON oauth_tokens (tenant_id, platform);

-- Platform channels a tenant is tracking. The (tenant_id, platform,
-- platform_channel_id) triple is unique so a re-sync cannot create duplicates.
CREATE TABLE IF NOT EXISTS video_channels (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL,
  platform           varchar(50) NOT NULL,
  platform_channel_id varchar(255) NOT NULL,
  channel_name       varchar(255),
  channel_url        text,
  -- Nullable CRM links. A channel may belong to a customer, a contact, both,
  -- or neither; the FK edges are read-only resolution links (same pattern as
  -- documents.customer_id in 0009).
  customer_id        uuid        REFERENCES customers(id),
  contact_id         uuid        REFERENCES contacts(id),
  ownership          varchar(20) NOT NULL DEFAULT 'self'
                     CHECK (ownership IN ('self', 'client')),
  oauth_token_id     uuid        REFERENCES oauth_tokens(id),
  status             varchar(20) NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'disconnected', 'suspended')),
  last_sync_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_video_channel_platform UNIQUE (tenant_id, platform, platform_channel_id)
);

CREATE INDEX IF NOT EXISTS idx_video_channels_tenant_status
  ON video_channels (tenant_id, status);

-- Daily earnings snapshots. One row per (channel, date); the unique constraint
-- makes re-syncs idempotent.
CREATE TABLE IF NOT EXISTS video_earnings (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL,
  channel_id          uuid        NOT NULL REFERENCES video_channels(id) ON DELETE CASCADE,
  date                date        NOT NULL,
  estimated_earnings  decimal(12,2),
  currency            varchar(3)  NOT NULL DEFAULT 'USD',
  ad_revenue          decimal(12,2),
  cpm                 decimal(8,2),
  rpm                 decimal(8,2),
  views_count         integer,
  -- Free-form sidecar (video-level breakdown, A/B test flags, etc.).
  metadata            jsonb       DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_video_earnings_channel_date UNIQUE (channel_id, date)
);

CREATE INDEX IF NOT EXISTS idx_video_earnings_tenant_date
  ON video_earnings (tenant_id, date DESC);

-- Weekly audience / engagement roll-ups. One row per (channel, week_start).
CREATE TABLE IF NOT EXISTS video_audience_metrics (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL,
  channel_id          uuid        NOT NULL REFERENCES video_channels(id) ON DELETE CASCADE,
  week_start          date        NOT NULL,
  subscribers_count   integer,
  total_views         integer,
  watch_time_minutes  bigint,
  engagement_rate     decimal(5,4),
  metadata            jsonb       DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_video_audience_channel_week UNIQUE (channel_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_video_audience_tenant_week
  ON video_audience_metrics (tenant_id, week_start DESC);

-- Triggers: auto-stamp updated_at on every mutation.
DROP TRIGGER IF EXISTS trg_oauth_tokens_touch ON oauth_tokens;
CREATE TRIGGER trg_oauth_tokens_touch BEFORE UPDATE ON oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();

DROP TRIGGER IF EXISTS trg_video_channels_touch ON video_channels;
CREATE TRIGGER trg_video_channels_touch BEFORE UPDATE ON video_channels
  FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();
