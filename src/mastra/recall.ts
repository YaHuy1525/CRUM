import { PgVector } from '@mastra/pg'
import { crumEmbeddingModel } from './embeddings'
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

  // createCrumMastra runs per-request on the health/feedback/usage/digest REST
  // lanes, so without this cache each such request would build its own recall
  // pool. The pool counts against the Supabase budget (POOL_COUNT=3 × max ≤ 15,
  // env.ts:24-28). Keyed on every value that changes the result: the passed
  // env for storage/embedder-override inputs, and process.env for the
  // embedding endpoint, which crumEmbeddingModel reads via its own argless
  // parseEnv (embeddings.ts:14) — credentials are stable within a process.
  const key = [
    connectionString,
    env.MASTRA_PG_SSL ?? '',
    String(env.MASTRA_PG_POOL_MAX),
    env.MASTRA_MEMORY_EMBEDDER ?? '',
    process.env.EMBEDDING_BASE_URL ?? '',
    process.env.EMBEDDING_API_KEY ?? '',
    process.env.MODEL_API_KEY ?? '',
  ].join('\u0000')
  const cached = depsCache.get(key)
  if (cached) return cached
  const deps = createRecallDeps(connectionString, env)
  depsCache.set(key, deps)
  return deps
}

const depsCache = new Map<string, RecallDeps>()

function createRecallDeps(connectionString: string, env: CrumEnv): RecallDeps {
  const vector = new PgVector({
    id: 'pg-crum-recall',
    connectionString,
    // Supabase requires TLS; same rule as buildMastraStorage (storage.ts:115).
    ssl: resolveSsl(connectionString, env.MASTRA_PG_SSL),
    // Tier A: one shared schema for all tenants; isolation is the server-derived
    // injective resourceId predicate (research doc §4, ruling 2026-10-30), not
    // a per-tenant schema.
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
