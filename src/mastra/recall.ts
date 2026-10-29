import { PgVector } from '@mastra/pg'
import { crumEmbeddingModel, EMBEDDING_DIMENSIONS } from './embeddings'
import { pgPoolMax, resolveSsl } from './storage'
import type { CrumEnv } from '../config/env'

export interface RecallDeps {
  vector: PgVector
  embedder: ReturnType<typeof crumEmbeddingModel>
}

// Built lazily inside createCrumMastra; never at import time (CI key-hygiene
// trap, spec §1 constraint #2). undefined => recall stays off.
export function buildRecallDeps(env: CrumEnv): RecallDeps | undefined {
  if (!env.CRUM_RECALL_ENABLED) return undefined
  const connectionString = env.DATABASE_URL
  if (!connectionString) return undefined

  const vector = new PgVector({
    id: 'pg-crum-recall',
    connectionString,
    // Supabase requires TLS; same rule as buildMastraStorage (storage.ts:115).
    ssl: resolveSsl(connectionString, env.MASTRA_PG_SSL),
    // Tier A: one shared schema for all tenants; isolation is the double
    // filter (research doc §4), not a per-tenant schema.
    schemaName: 'mastra_memory',
    // PgVector's own default pool max is 20 (@mastra/pg/dist/index.js:601);
    // cap it like every other pool or the Supabase budget check breaks (§6).
    pgPoolOptions: { max: pgPoolMax(env) },
  })

  // MASTRA_MEMORY_EMBEDDER is a model-id override; unset => EMBEDDING_MODEL_ID.
  // Only a 'provider/model'-shaped value is accepted; a malformed override
  // silently falls back to the CRUM default rather than crashing recall.
  const override = env.MASTRA_MEMORY_EMBEDDER
  const embedder = crumEmbeddingModel(
    override && override.includes('/') ? (override as `${string}/${string}`) : undefined,
  )
  return { vector, embedder }
}

// Shared with Memory's semanticRecall.indexConfig: the recall index must match
// the RAG index dimensions and metric (research doc §5). Without indexConfig,
// PgVector's lazy createIndex silently builds ivfflat, diverging from
// CRUM_VECTOR_CONFIG.
export const RECALL_VECTOR_CONFIG = {
  dimension: EMBEDDING_DIMENSIONS,
  metric: 'cosine' as const,
  indexConfig: { type: 'hnsw' as const, hnsw: { m: 16, efConstruction: 64 } },
}
