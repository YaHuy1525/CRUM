-- migrations/0006_crum_gmail_connections.sql
--
-- Version 0006, not 0005: scripts/db-migrate.ts derives the recorded version from
-- the 4-digit filename prefix alone, and crum_schema_migrations.version is a
-- PRIMARY KEY. Two files sharing a prefix therefore cannot both be applied --
-- the second INSERT collides, the transaction rolls back, and the whole migration
-- run fails. 0005_crum_parity.sql (Wave 1B, referenced by the phase-8 handoff)
-- holds 0005; this one was added later and moves to the next free number.
-- Per-user Gmail connections for the mail connector.
--
-- One mailbox per (tenant, user): a re-consent replaces the token rather than
-- adding a second connection. The refresh token is stored only as an
-- AES-256-GCM ciphertext produced by src/gmail/crypto.ts (key derived from
-- APPROVAL_HMAC_SECRET via HKDF); the plaintext never lands in this table.
-- There is no access_token column by design: short-lived tokens belong in the
-- process cache, not in the database.

CREATE TABLE IF NOT EXISTS gmail_connections (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL,
  user_id           uuid        NOT NULL,
  gmail_email       text        NOT NULL,
  refresh_token_enc text        NOT NULL,
  scopes            text        NOT NULL DEFAULT '',
  connected_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_gmail_connection UNIQUE (tenant_id, user_id)
);

DROP TRIGGER IF EXISTS trg_gmail_connections_touch ON gmail_connections;
CREATE TRIGGER trg_gmail_connections_touch BEFORE UPDATE ON gmail_connections
FOR EACH ROW EXECUTE FUNCTION crum_touch_updated_at();
