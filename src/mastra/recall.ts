import { PgVector } from '@mastra/pg'
import { EMBEDDING_MODELS } from '@mastra/core/llm'
import { crumEmbeddingModel } from './embeddings'
import { pgPoolMax, resolveSsl } from './storage'
import type { CrumEnv } from '../config/env'

export interface RecallDeps {
  vector: PgVector
  embedder: ReturnType<typeof crumEmbeddingModel>
  /**
   * Declared output dimension of `embedder`, whenever we can know it positively.
   *
   * Why this is load-bearing: on EVERY chat turn Memory builds the semantic-recall
   * processor through `getInputProcessors` and `getOutputProcessors`, and both call
   * `getEmbeddingDimension()` (@mastra/core/dist/agent-tuAMgHe3.js:22015, :22114).
   * With nothing declared, that method embeds a probe string over the network
   * (:21779-21796) and wraps any failure as MASTRA_MEMORY_GET_EMBEDDING_DIMENSION_
   * FAILED. That throw happens in the processor *builder*, outside the try/catch
   * inside SemanticRecall itself (:23061-23077 input, :23272-23348 output), which is
   * why one dead embedding endpoint aborted every turn instead of just losing recall
   * (observed live 2026-10-30 as `connect ECONNREFUSED 127.0.0.1:20128`, the dead
   * local gateway that an ambient OPENAI_BASE_URL pointed the router at). Declaring
   * the dimension makes :21778 return synchronously and pushes embedding failures
   * back onto the graceful path. See memory/types.d.ts:1187-1199.
   */
  embeddingDimension?: number
}

/**
 * Pick the dimension to declare for `modelId`, which is the embedder instance's
 * provider-stripped id: ModelRouterEmbeddingModel normalises both constructor
 * shapes ('provider/model' string and OpenAICompatibleConfig) to that form
 * (llm-CykoLI1F.js:9137-9185), and EMBEDDING_MODELS is keyed the same way
 * (:9090-9119).
 *
 * The precedence is deliberately "positive knowledge only", because a declared
 * value that disagrees with reality is not fail-soft: SemanticRecall rethrows
 * MASTRA_MEMORY_EMBEDDING_DIMENSION_MISMATCH from a real embedding (:23076,
 * :23345), so a wrong number would abort turns again. Order:
 *
 *   1. Mastra's curated table, when it knows the model. Authoritative and exactly
 *      what the probe would have measured, so it also wins over a disagreeing env
 *      value — an env variable cannot change what the endpoint returns.
 *   2. The operator's EMBEDDING_DIMENSIONS, for a model the table does not list.
 *   3. undefined, which restores Mastra's probe (the pre-hardening behaviour)
 *      rather than guessing a dimension for an unknown embedder.
 */
export function resolveEmbeddingDimension(
  modelId: string,
  configured?: number,
): number | undefined {
  return EMBEDDING_MODELS.find((model) => model.id === modelId)?.dimensions ?? configured
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
    String(env.EMBEDDING_DIMENSIONS ?? ''),
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

  // Resolved from the built instance rather than from the env model id so an
  // override (or a future default change) can never drift from what actually
  // gets embedded. Runs here, on a cache miss only, so a disagreement warning
  // cannot spam the per-request REST lanes.
  const embeddingDimension = resolveEmbeddingDimension(embedder.modelId, env.EMBEDDING_DIMENSIONS)
  if (env.EMBEDDING_DIMENSIONS !== undefined && embeddingDimension !== env.EMBEDDING_DIMENSIONS) {
    console.warn(
      `[CRUM] EMBEDDING_DIMENSIONS=${env.EMBEDDING_DIMENSIONS} ignored for ` +
        `${embedder.provider}/${embedder.modelId}: Mastra's curated table declares ` +
        `${embeddingDimension}, which is what the endpoint returns.`,
    )
  }
  if (embeddingDimension === undefined) {
    // Nothing positive is known about this embedder's width, so the probe stays
    // in the turn-critical path and an unreachable endpoint can abort chat again.
    // Say so instead of silently keeping the hazard; setting EMBEDDING_DIMENSIONS
    // is the fix, and guessing a width would only swap in the mismatch failure.
    console.warn(
      `[CRUM] embedding dimension unknown for ${embedder.provider}/${embedder.modelId}: ` +
        `Memory will probe the embedder on every chat turn, so an unreachable embedding ` +
        `endpoint aborts turns rather than only losing recall. Set EMBEDDING_DIMENSIONS.`,
    )
  }
  return { vector, embedder, embeddingDimension }
}
