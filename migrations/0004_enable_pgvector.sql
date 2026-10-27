-- migrations/0004_enable_pgvector.sql
-- §6.3.4 — enable the vector extension so tenant schemas can create
-- HNSW-indexed vector tables. Idempotent: IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS vector;
