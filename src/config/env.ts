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

// `KEY=` in an env file is an unset key, not a failed boot. optionalString
// already reads it that way; a key that carries a constraint needs the blank
// mapped to undefined before the constraint runs, which is what preprocess is
// for.
function blankAsUnset(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value
}

const hmacSecret = z.string().min(32, 'must be at least 32 bytes').optional()

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

// Three pg.Pool instances on the main connection: storage, observability, and
// the semantic-recall PgVector (src/mastra/recall.ts).
export const POOL_COUNT = 3
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
    .max(MAX_POOL_PER_CONN, `${POOL_COUNT} pools x max must stay under Supabase pool_size (${SUPABASE_POOL_SIZE})`)
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

  // Model-id override for the semantic-recall embedder, wired by the recall
  // factory (see src/mastra/recall.ts); unset falls back to EMBEDDING_MODEL_ID.
  MASTRA_MEMORY_EMBEDDER: optionalString,
  // Level 3 semantic recall kill-switch (spec §5). Off keeps message-history
  // recall and drops the vector lane altogether, which also silences
  // observational indexing and makes thread search throw (research doc §4).
  CRUM_RECALL_ENABLED: booleanish.prefault('true'),

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

  // Document parse sidecar (Docling). Unset or unreachable, intake falls back
  // to the in-process unpdf/mammoth path and still records blocks.
  DOCLING_URL: optionalString,

  // OCR sidecar (Tesseract). Unset or unreachable, image documents fall back
  // to the in-process plain text path. Works alongside or instead of Docling.
  OCR_URL: optionalString,

  // Redis for the BullMQ document and batch queues. The queue modules fall back
  // to localhost when unset, so an install that never boots a worker is
  // unaffected; it is the queue side that fails, not the boot.
  REDIS_URL: optionalString,

  // Video revenue tracking – AES-256-GCM key used to encrypt OAuth refresh
  // tokens at rest.  Must be a 32-byte value encoded as 64 hex characters.
  // Required in production; optional in dev/test (tokens stay unencrypted).
  OAUTH_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'must be exactly 64 hex characters (32 bytes)')
    .optional(),

  // Video revenue tracking - YouTube
  VIDEO_YOUTUBE_CLIENT_ID: optionalString,
  VIDEO_YOUTUBE_CLIENT_SECRET: optionalString,
  VIDEO_YOUTUBE_REDIRECT_URI: optionalString,

  // Video revenue tracking - TikTok
  VIDEO_TIKTOK_CLIENT_ID: optionalString,
  VIDEO_TIKTOK_CLIENT_SECRET: optionalString,
  VIDEO_TIKTOK_REDIRECT_URI: optionalString,

  // Video revenue tracking - Instagram
  VIDEO_INSTAGRAM_CLIENT_ID: optionalString,
  VIDEO_INSTAGRAM_CLIENT_SECRET: optionalString,
  VIDEO_INSTAGRAM_REDIRECT_URI: optionalString,

  // Video revenue tracking - Twitch
  VIDEO_TWITCH_CLIENT_ID: optionalString,
  VIDEO_TWITCH_CLIENT_SECRET: optionalString,
  VIDEO_TWITCH_REDIRECT_URI: optionalString,

  // Marketing slice 2: the page host and the inbound lead lane. Every one of
  // these is optional here, and the page adapters register at boot only when the
  // account, project, token and branch are all present — an action must not be
  // approvable before it is executable, and a half-configured host would stage a
  // publish that can never run.
  CRUM_CLOUDFLARE_ACCOUNT_ID: optionalString,
  CRUM_CLOUDFLARE_PAGES_PROJECT: optionalString,
  // A secret: the injection guard fails open when an expected key is absent, and
  // a marketing agent reading untrusted page copy is where that matters. Blank is
  // unset, because an .env.example placeholder line must not stop an
  // unconfigured install from booting.
  CRUM_CLOUDFLARE_API_TOKEN: z.preprocess(
    blankAsUnset,
    z.string().trim().min(32, 'must be at least 32 bytes').optional(),
  ),
  CRUM_PAGES_PRODUCTION_BRANCH: optionalString,
  // Unset means the documented Cloudflare endpoint. A test or a local stand-in
  // points the adapters elsewhere without a code change.
  CRUM_PAGES_API_BASE_URL: optionalString,
  CRUM_MARKETING_SITE_ORIGIN: optionalString,
  CRUM_LEAD_API_ORIGIN: optionalString,
  // Blank means unset, so the default cap applies instead of a coerced 0 that
  // fails min(1).
  CRUM_MARKETING_LEAD_DAILY_CAP: z.preprocess(
    blankAsUnset,
    z.coerce.number().int().min(1).max(100_000).default(200),
  ),

  // Slice 3 spec section 7: Conversions API. Both must be present for the
  // sender to register; either absent means the lead route skips the API call
  // and logs a warning, so a half-configured install never fails intake.
  CRUM_META_PIXEL_ID: optionalString,
  CRUM_META_ADS_ACCESS_TOKEN: z.preprocess(
    blankAsUnset,
    z.string().trim().min(1).optional(),
  ),
  // Slice 3 spec section 5.4: the ad accounts the create_campaign adapter
  // accepts. Parsed as a JSON array of strings at boot; absent means the Meta
  // Ads adapters stay unmapped and staging refuses.
  CRUM_META_AD_ACCOUNTS: optionalString,
  // Slice 4 spec section 11: Replicate image generation. The token is a secret,
  // so blank means unset and an `KEY=` placeholder line in an env file cannot
  // make a boot fail on a length constraint. Absent token means no adapter
  // registers and marketing.generate_assets refuses at call time.
  CRUM_REPLICATE_API_TOKEN: z.preprocess(
    blankAsUnset,
    z.string().trim().min(32, 'must be at least 32 bytes').optional(),
  ),
  CRUM_REPLICATE_MODEL: z.preprocess(
    blankAsUnset,
    z.string().trim().min(1).default('black-forest-labs/flux-1.1-pro'),
  ),
  // Which registered provider this deployment pays. One name, because a fallback
  // would make the ceiling arithmetic a lie (spec section 8.1). The value is not
  // validated against a list here: the registry is built at boot, and
  // marketing.generate_assets refuses an unknown name with `image_provider_unknown`
  // naming what *is* registered, which is a better message than a boot failure on a
  // spelling.
  CRUM_IMAGE_PROVIDER: z.preprocess(blankAsUnset, z.string().trim().min(1).default('replicate')),
  // Minor units, i.e. cents: the same unit line `marketing_image_spend` stores,
  // so the ceiling and the ledger are one number line and a reader never has to
  // convert between them. 2000 is $20 a day.
  CRUM_IMAGE_SPEND_CEILING_MINOR: z.preprocess(
    blankAsUnset,
    z.coerce.number().int().min(1).max(10_000_000).default(2000),
  ),
  // The admission estimate, deliberately not the real price: it decides whether
  // a run is allowed to start, and the ledger records what Replicate actually
  // charged. A ceiling that only ever sees estimates would drift.
  CRUM_IMAGE_COST_MINOR_PER_IMAGE: z.preprocess(
    blankAsUnset,
    z.coerce.number().int().min(1).max(100_000).default(4),
  ),
  // Minor units, so 200 is $2.00. Lifetime per bundle rather than per day: this
  // number exists to stop one runaway loop on one bundle (spec section 7.1), and at
  // the 4-minor admission estimate above it admits fifty images before a bundle is
  // capped. No campaign page needs fifty, and a bundle that needed forty is a
  // creative problem rather than a budget one.
  CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE: z.preprocess(
    blankAsUnset,
    z.coerce.number().int().min(1).max(10_000_000).default(200),
  ),
  // Slice 5 spec section 9.2: a staged draft needs a uuid actor, and the analyst
  // cron is the only caller that has no human in the loop. Blank is unset, like
  // every other credential here, so an `CRUM_ANALYST_USER_ID=` placeholder line
  // cannot fail a boot. Unset means the cron reports its recommendations and
  // stages nothing, because inventing a synthetic person to satisfy a column that
  // means "who asked" would put a fiction in the audit trail. Shape is as far as a
  // config file can reach: pending_writes.requested_by carries no foreign key
  // (migrations/0002_crum_spine.sql:158), so nothing here can tell a uuid that
  // names a user from one that does not, and `.env.example` states the operator's
  // half of that bargain instead of implying a check this file does not perform.
  CRUM_ANALYST_USER_ID: z.preprocess(
    blankAsUnset,
    z
      .string()
      .uuid('CRUM_ANALYST_USER_ID must be a uuid, the shape pending_writes.requested_by needs')
      .optional(),
  ),
})

export type CrumEnv = z.infer<typeof EnvSchema>

export const DEFERRED_ENV_VARS: Readonly<Record<string, number>> = {
  SUPABASE_JWT_ISSUER: 1,
  SUPABASE_JWT_AUDIENCE: 1,
  MASTRA_BASE_URL: 1,
  MASTRA_REQUEST_TIMEOUT_SECONDS: 1,
  MASTRA_API_PREFIX: 1,
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
  OAUTH_ENCRYPTION_KEY: 6,
}

export const PRODUCTION_REQUIRED_SECRETS: readonly string[] = [
  'DATABASE_URL',
  'OPENROUTER_API_KEY',
  'APPROVAL_HMAC_SECRET',
  'MCP_REQUEST_STATE_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  // Required only for a production install that publishes pages. A Pages-free
  // production boot is legitimate, so whoever wires this list into boot must not
  // make the entry fatal on its own: the adapters simply stay unregistered and
  // staging refuses. A deployment that does publish, though, must not lose the
  // token quietly, and the injection guard fails open when an expected key is
  // absent.
  'CRUM_CLOUDFLARE_API_TOKEN',
  // Slice 4: the same reasoning as the Pages token above, one step further
  // (spec section 14). The parent spec's tiger T2 note is that the injection
  // guard fails open when an expected key is absent, and a designer reading
  // prospect copy is precisely where a stray instruction could end up on a bill.
  'CRUM_REPLICATE_API_TOKEN',
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
