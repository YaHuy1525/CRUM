import { z } from 'zod'

export class EnvParseError extends Error {
  readonly issues: unknown[]

  constructor(message: string, issues: unknown[] = []) {
    super(message)
    this.name = 'EnvParseError'
    this.issues = issues
  }
}

const optionalString = z
  .string()
  .transform((v) => (v.trim() === '' ? undefined : v))
  .optional()

const hmacSecret = z.string().min(32, 'must be at least 32 bytes').optional()

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

export const POOL_COUNT = 2
export const SUPABASE_POOL_SIZE = 15
export const MAX_POOL_PER_CONN = Math.floor(SUPABASE_POOL_SIZE / POOL_COUNT)

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: optionalString,
  OBSERVABILITY_DATABASE_URL: optionalString,
  OPENROUTER_API_KEY: optionalString,
  APPROVAL_HMAC_SECRET: hmacSecret,
  MCP_REQUEST_STATE_KEY: hmacSecret,
  SUPABASE_URL: optionalString,
  SUPABASE_SERVICE_ROLE_KEY: optionalString,
  SUPABASE_JWKS_URL: optionalString,

  CRUM_AUTH_MODE: z.enum(['dev', 'jwt']).default('dev'),
  CRUM_MODEL_MAIN: optionalString,
  CRUM_MODEL_LIGHT: optionalString,
  CRUM_API_PORT: z.coerce.number().int().min(1).max(65535).default(4111),
  CRUM_API_HOST: optionalString,
  CRUM_REST_PORT: z.coerce.number().int().min(1).max(65535).default(4113),
  CRUM_REST_HOST: optionalString,

  MASTRA_OBSERVABILITY: booleanish.prefault('false'),
  MASTRA_TRACE_PROBABILITY: z.coerce.number().min(0).max(1).default(1),
  MASTRA_PG_SSL: z
    .enum(['true', 'false', ''])
    .transform((v) => (v === '' ? undefined : v))
    .optional(),
  MASTRA_PG_POOL_MAX: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_POOL_PER_CONN, `2 pools x max must stay under Supabase pool_size (${SUPABASE_POOL_SIZE})`)
    .default(4),
  MASTRA_DB_DISABLE_INIT: booleanish.prefault('true'),

  // Observational memory (Level 4). On by default; set false to revert to the
  // plain messageHistory window (spec §4 kill-switch).
  CRUM_OM_ENABLED: booleanish.prefault('true'),

  POLICY_DIR: optionalString,
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),

  EMBEDDING_MODEL_ID: optionalString,
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).optional(),
  EMBEDDING_BASE_URL: optionalString,
  EMBEDDING_API_KEY: optionalString,

  TYPESAFE_AI_API_KEY: optionalString,
  TYPESAFE_AI_BASE_URL: optionalString,

  JUDGE_PROVIDER: optionalString,
  JUDGE_MODEL: optionalString,
  JEV_API_KEY: optionalString,
  JUDGE_CHAT_BASE_URL: optionalString,
  JUDGE_CHAT_MODEL: optionalString,
  JUDGE_CHAT_API_KEY: optionalString,
  JUDGE_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(60),
  EVAL_EXPERIMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  MASTRA_AUTO_REFRESH_PRICING: booleanish.prefault('false'),

  CRUM_DIGEST_CRON: optionalString,

  GMAIL_OAUTH_CLIENT_ID: optionalString,
  GMAIL_OAUTH_CLIENT_SECRET: optionalString,
  GMAIL_REDIRECT_URI: optionalString,
})

export type CrumEnv = z.infer<typeof EnvSchema>

export const DEFERRED_ENV_VARS: Readonly<Record<string, number>> = {
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
}

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
  if (result.success) {
    const env = result.data
    if (env.NODE_ENV === 'production' && env.CRUM_AUTH_MODE === 'dev') {
      throw new EnvParseError(
        'CRUM_AUTH_MODE cannot be "dev" in production: it trusts the ' +
          'x-tenant-id/x-user-id/x-user-role request headers, which a client can ' +
          'forge. Set CRUM_AUTH_MODE="jwt" so identity comes from a verified ' +
          'Supabase token (§13.2, §13.8).',
      )
    }
    return env
  }

  const summary = result.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  throw new EnvParseError(`environment failed validation:\n${summary}`, result.error.issues)
}

export function isProduction(env: CrumEnv): boolean {
  return env.NODE_ENV === 'production'
}

export function missingProductionSecrets(env: CrumEnv): string[] {
  return PRODUCTION_REQUIRED_SECRETS.filter((name) => {
    const value = env[name as keyof CrumEnv]
    return typeof value !== 'string' || value.length === 0
  })
}
