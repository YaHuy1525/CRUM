import { z } from 'zod'

/** Raised for a malformed environment. Carries the Zod issues for the log line. */
export class EnvParseError extends Error {
  readonly issues: unknown[]

  constructor(message: string, issues: unknown[] = []) {
    super(message)
    this.name = 'EnvParseError'
    this.issues = issues
  }
}

/**
 * An empty string in a dotenv file means unset, not "the empty string".
 *
 * `.optional()` has to wrap the whole pipeline, not sit at the end of the pipe.
 * A bare `z.string()` rejects an absent key outright — `parseEnv({})` threw
 * "POLICY_DIR: Invalid input: expected string, received undefined" on all five
 * optional-string fields, which is every test that passes an exact environment.
 * The `.pipe(z.string().min(1))` the plan had here was also dead weight: the
 * transform has already turned `''` and whitespace-only values into `undefined`,
 * so nothing that reaches `min(1)` can be shorter than one character.
 */
const optionalString = z
  .string()
  .transform((v) => (v.trim() === '' ? undefined : v))
  .optional()

/** A secret used for HMAC signing. §12.3 and §10.3.3 both require >= 32 bytes. */
const hmacSecret = z.string().min(32, 'must be at least 32 bytes').optional()

/**
 * Dotenv booleans. Callers must default this with `.prefault(...)`, NOT
 * `.default(...)`.
 *
 * Zod 4 split the two: `.default(x)` supplies a default **output** and skips
 * parsing, and its parameter is typed against the output; `.prefault(x)`
 * supplies a default **input** and runs it through the schema normally. Under
 * Zod 3 `.default('false')` was the input form, which is what the plan text
 * assumed. Here the input type is the enum and the output type is `boolean`, so
 * `.default('false')` is a compile error (TS2769) and, if forced through, hands
 * back the *string* `'false'` — which is truthy. `MASTRA_OBSERVABILITY` would
 * then read as enabled on every default boot, the exact opposite of the
 * documented "off by default so tests pay nothing". Verified by probe: absent
 * key yields `"false"` (string) under `.default`, and `false` (boolean) under
 * both `.prefault('false')` and `.default(false)`. `.prefault` is used so the
 * default travels the same transform as a real value, keeping one definition of
 * what counts as truthy.
 */
const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

/**
 * Supabase's session-mode pooler caps total clients at 15 by default. Mastra
 * opens a writer pool and, when `readPool` is unset, falls back to it for reads,
 * so PostgresStoreVNext holds 2 pools: primary and observability. 2 x 7 = 14 is
 * the highest safe per-pool cap. §9.1 and §14.3.
 */
export const POOL_COUNT = 2
export const SUPABASE_POOL_SIZE = 15
export const MAX_POOL_PER_CONN = Math.floor(SUPABASE_POOL_SIZE / POOL_COUNT)

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Required in production, optional elsewhere so the stack boots in-memory.
  DATABASE_URL: optionalString,
  /**
   * Where observability spans, logs, metrics, scores and feedback are written.
   * PostgresStoreVNext requires an observability connection and will not
   * implicitly share the primary one (@mastra/pg dist/storage/index.d.ts:104).
   * Unset falls back to DATABASE_URL and accepts the runtime warning the
   * adapter logs on every construction. Point this at a separate database
   * before enabling MASTRA_OBSERVABILITY in production. §9.1, §14.3.
   */
  OBSERVABILITY_DATABASE_URL: optionalString,
  OPENROUTER_API_KEY: optionalString,
  APPROVAL_HMAC_SECRET: hmacSecret,
  MCP_REQUEST_STATE_KEY: hmacSecret,
  SUPABASE_URL: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,

  // Mastra runtime (§13.3)
  MASTRA_OBSERVABILITY: booleanish.prefault('false'),
  MASTRA_TRACE_PROBABILITY: z.coerce.number().min(0).max(1).default(1),
  MASTRA_PG_SSL: z.enum(['true', 'false']).optional(),
  MASTRA_PG_POOL_MAX: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_POOL_PER_CONN, `2 pools x max must stay under Supabase pool_size (${SUPABASE_POOL_SIZE})`)
    .default(4),
  MASTRA_DB_DISABLE_INIT: booleanish.prefault('true'),

  // Governance (§13.4)
  POLICY_DIR: optionalString,
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),

  // Phase 4: RAG embeddings (§6.4)
  EMBEDDING_MODEL_ID: optionalString,
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).optional(),
  EMBEDDING_BASE_URL: optionalString,
  EMBEDDING_API_KEY: optionalString,

  // Phase 5: classification decision model (§6.5.2)
  TYPESAFE_AI_API_KEY: optionalString,
  TYPESAFE_AI_BASE_URL: optionalString,
})

export type CrumEnv = z.infer<typeof EnvSchema>

/**
 * Variables documented in .env.example that Phase 0 does not read yet. Each is
 * mapped to the phase that will. tests/config/env.test.ts fails if a documented
 * variable is neither parsed nor listed here, so this map cannot rot quietly.
 */
export const DEFERRED_ENV_VARS: Readonly<Record<string, number>> = {
  SUPABASE_JWKS_URL: 1,
  SUPABASE_JWT_ISSUER: 1,
  SUPABASE_JWT_AUDIENCE: 1,
  MASTRA_BASE_URL: 1,
  MASTRA_REQUEST_TIMEOUT_SECONDS: 1,
  MASTRA_API_PREFIX: 1,
  MASTRA_MEMORY_EMBEDDER: 1,
  NEXT_PUBLIC_SUPABASE_URL: 1,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 1,
  RETRIEVAL_TOP_K: 4,
  RETRIEVAL_MIN_SCORE: 4,
  RETRIEVAL_HNSW_EF: 4,
  RETRIEVAL_IVF_PROBES: 4,
  RETRIEVAL_RERANK_MODEL: 4,
  RETRIEVAL_RERANK_TOP_K: 4,
  RETRIEVAL_TENANT_OVERRIDES: 4,
  COHERE_API_KEY: 4,
  RUNS_MAX_CONCURRENT_MODEL_CALLS: 3,
  RUNS_APPROVAL_TOKEN_TTL_SECONDS: 3,
  RUNS_RECEIPT_RECORD_TTL_SECONDS: 3,
  RUNS_SWEEP_INTERVAL_SECONDS: 3,
  CORS_ALLOW_ORIGINS: 5,
  TRUSTED_PROXY_IPS: 5,
  JEV_API_KEY: 6,
  JUDGE_PROVIDER: 6,
  JUDGE_MODEL: 6,
  JUDGE_CHAT_BASE_URL: 6,
  JUDGE_CHAT_MODEL: 6,
  JUDGE_CHAT_API_KEY: 6,
  JUDGE_TIMEOUT_SECONDS: 6,
  EVAL_EXPERIMENT_TIMEOUT_MS: 6,
  MASTRA_AUTO_REFRESH_PRICING: 6,
}

/**
 * Secrets whose absence in production is a deployment defect rather than a
 * degraded feature. §13.8: CRUM fails open to safe everywhere except identity
 * and continuation signing, because both guard properties that cannot be
 * verified at request time.
 */
export const PRODUCTION_REQUIRED_SECRETS: readonly string[] = [
  'DATABASE_URL',
  'OPENROUTER_API_KEY',
  'APPROVAL_HMAC_SECRET',
  'MCP_REQUEST_STATE_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
]

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): CrumEnv {
  const result = EnvSchema.safeParse(raw)
  if (result.success) return result.data

  const summary = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  throw new EnvParseError(`environment failed validation:\n${summary}`, result.error.issues)
}

export function isProduction(env: CrumEnv): boolean {
  return env.NODE_ENV === 'production'
}

/**
 * Names of production-required secrets that are absent or empty.
 *
 * Deliberately unconditional: this reports the facts and the caller decides what
 * they mean. `isProduction(env) && missingProductionSecrets(env).length > 0` is
 * the deployment defect; a non-empty result on its own is not, because a local
 * run without Supabase credentials is a supported configuration rather than a
 * broken one (§14.4) and still needs an accurate list to log. Folding the
 * NODE_ENV check in here would make the development case return `[]` and leave
 * the caller unable to tell "all present" from "not production, did not look".
 *
 * Length is not checked here. `hmacSecret` already rejects anything under 32
 * bytes during `parseEnv`, so a `CrumEnv` cannot hold a short HMAC secret — by
 * the time this runs, "too short" is unreachable and only absence remains.
 */
export function missingProductionSecrets(env: CrumEnv): string[] {
  return PRODUCTION_REQUIRED_SECRETS.filter((name) => {
    const value = env[name as keyof CrumEnv]
    return typeof value !== 'string' || value.length === 0
  })
}
