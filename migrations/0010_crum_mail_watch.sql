-- migrations/0010_crum_mail_watch.sql
--
-- Version 0010: 0009_crum_documents.sql holds the previous number, and
-- scripts/db-migrate.ts keys crum_schema_migrations.version by the 4-digit
-- filename prefix, so prefixes must stay unique (see the note in 0006).
--
-- Inbound-mail watching: what the poller (scripts/mail-watch.ts) writes and
-- the digest reads.
--
--   * gmail_connections.watch: the per-user opt-in. Connecting a mailbox does
--     NOT start watching it; the poller only reads mailboxes a human turned on.
--   * mail_messages: a metadata mirror of watched inbound mail — Gmail's own
--     message id is the primary key, so re-polls are idempotent and the very
--     first watch of a large mailbox self-limits (once a page is entirely
--     known rows, the frontier is reached and paging stops).
--
-- body_text stays NULL for now on purpose: the connector's granted scope is
-- gmail.readonly, whose metadata-only responses carry the snippet but not the
-- full body, and storing un-scoped content would be worse than storing none.

ALTER TABLE gmail_connections
  ADD COLUMN IF NOT EXISTS watch boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS mail_messages (
  id            text        PRIMARY KEY,               -- Gmail message id (base64hex)
  tenant_id     uuid        NOT NULL,
  user_id       uuid        NOT NULL,
  gmail_email   text        NOT NULL,
  thread_id     text        NOT NULL,
  subject       text        NOT NULL DEFAULT '',
  senders       text[]      NOT NULL DEFAULT '{}',
  recipients    text[]      NOT NULL DEFAULT '{}',
  snippet       text        NOT NULL DEFAULT '',
  date_header   text        NOT NULL DEFAULT '',
  received_at   timestamptz NOT NULL DEFAULT now(),    -- Gmail internalDate
  body_text     text,
  fetched_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_mail_messages_tenant_received
  ON mail_messages (tenant_id, received_at DESC);
CREATE INDEX IF NOT EXISTS ix_mail_messages_thread
  ON mail_messages (thread_id);
