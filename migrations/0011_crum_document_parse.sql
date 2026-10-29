-- Document scan upgrade (Phase 1 of the Reducto-layer plan).
--
-- Version 0011: next free number after 0010; scripts/db-migrate.ts keys
-- crum_schema_migrations on the 4-digit prefix, so 0001..0010 are taken.
--
-- Do not add BEGIN or COMMIT here; the runner wraps this file and its version
-- record in one transaction.
--
-- These tables fix three structural gaps in the 0009 intake:
--   1. document_files keeps the ORIGINAL bytes. Before this the upload was
--      shredded after text extraction, so a better parser could never be
--      pointed at old documents.
--   2. document_parses records one row per parse RUN (which parser produced
--      the representation, when, how long). A re-parse adds a new row instead
--      of destroying history — the Reducto "parse is a cached, versioned
--      representation" pattern.
--   3. document_blocks stores the structured intermediate: per-page blocks
--      with a type, Markdown content, an optional normalized bbox and char
--      offsets into documents.content_text. This is the citation substrate
--      every downstream feature (review UI, per-field provenance) reads.
--
-- Same conventions as 0009: non-nullable tenant_id on every table, tenant
-- predicate applied in the query layer (§5.2), no rollback scripts.

-- The original upload, one row per document. ON DELETE CASCADE retires it with
-- the parent. bytea is fine at the 15 MB intake ceiling (MAX_DOCUMENT_BYTES).
CREATE TABLE IF NOT EXISTS document_files (
  document_id  uuid        PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id    uuid        NOT NULL,
  mime         text        NOT NULL DEFAULT '',
  size_bytes   integer     NOT NULL,
  data         bytea       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- One row per parse run against a document. The newest status='ok' row is the
-- current representation; older rows are history.
CREATE TABLE IF NOT EXISTS document_parses (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    uuid        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id      uuid        NOT NULL,
  -- 'docling' | 'unpdf' | 'mammoth' | 'plain' (parser that produced the blocks).
  parser         text        NOT NULL,
  parser_version text        NOT NULL DEFAULT '',
  status         text        NOT NULL DEFAULT 'ok'
               CHECK (status IN ('ok', 'failed')),
  block_count    integer     NOT NULL DEFAULT 0,
  duration_ms    integer,
  -- Free-form run metadata (sidecar URL, page count, warnings).
  meta           jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- The structured intermediate. block_index is the 0-based reading order WITHIN
-- a page; the unique key makes re-inserting the same parse idempotent.
-- bbox is [x0, y0, x1, y1] normalized to 0..1 with a top-left origin, or null
-- when the parser cannot localize (plain-text fallback).
CREATE TABLE IF NOT EXISTS document_blocks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  parse_id     uuid        NOT NULL REFERENCES document_parses(id) ON DELETE CASCADE,
  document_id  uuid        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id    uuid        NOT NULL,
  page_number  integer     NOT NULL CHECK (page_number >= 1),
  block_index  integer     NOT NULL CHECK (block_index >= 0),
  block_type   text        NOT NULL
               CHECK (block_type IN ('header', 'footer', 'title', 'section_header',
                                     'page_number', 'list_item', 'figure', 'table',
                                     'key_value', 'text', 'comment', 'signature',
                                     'other')),
  content_md   text        NOT NULL,
  bbox         jsonb,
  confidence   numeric(4, 3),
  -- Character span into documents.content_text (null when the block does not
  -- map 1:1 onto the merged text, e.g. table Markdown re-renderings).
  char_start   integer,
  char_end     integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_block_position UNIQUE (parse_id, page_number, block_index)
);

CREATE INDEX IF NOT EXISTS idx_document_parses_document ON document_parses (document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_blocks_document ON document_blocks (document_id, page_number, block_index);
CREATE INDEX IF NOT EXISTS idx_document_blocks_tenant   ON document_blocks (tenant_id);
