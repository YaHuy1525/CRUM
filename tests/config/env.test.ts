import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFERRED_ENV_VARS,
  EnvParseError,
  EnvSchema,
  PRODUCTION_REQUIRED_SECRETS,
  isProduction,
  missingProductionSecrets,
  parseEnv,
} from '@/config/env'
import { DEFAULT_REPLICATE_MODEL } from '@/marketing/replicate'

/** Names declared in .env.example, ignoring comments and blanks. */
function documentedNames(): string[] {
  return readFileSync(join(process.cwd(), '.env.example'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split('=')[0]!.trim())
    .filter((name) => name.length > 0)
}

describe('parseEnv', () => {
  it('applies every documented default on an empty environment', () => {
    const env = parseEnv({})
    expect(env.NODE_ENV).toBe('development')
    expect(env.MASTRA_PG_POOL_MAX).toBe(4)
    expect(env.POLICY_DIR).toBeUndefined()
    expect(env.MASTRA_OBSERVABILITY).toBe(false)
    expect(env.CRUM_AUTH_MODE).toBe('dev')
    expect(env.CRUM_API_PORT).toBe(4111)
    // The REST plane is a second port on purpose: Mastra reserves `/api`.
    expect(env.CRUM_REST_PORT).toBe(4113)
  })

  it('refuses dev identity in production (§13.2, §13.8)', () => {
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrowError(EnvParseError)
    expect(() => parseEnv({ NODE_ENV: 'production', CRUM_AUTH_MODE: 'dev' })).toThrowError(
      /CRUM_AUTH_MODE cannot be "dev" in production/,
    )
  })

  it('allows jwt identity in production', () => {
    expect(parseEnv({ NODE_ENV: 'production', CRUM_AUTH_MODE: 'jwt' }).CRUM_AUTH_MODE).toBe('jwt')
  })

  it('coerces numeric strings', () => {
    const env = parseEnv({ MASTRA_PG_POOL_MAX: '5', RATE_LIMIT_PER_MINUTE: '300' })
    expect(env.MASTRA_PG_POOL_MAX).toBe(5)
    expect(env.RATE_LIMIT_PER_MINUTE).toBe(300)
  })

  it('treats the observability flag as a boolean', () => {
    expect(parseEnv({ MASTRA_OBSERVABILITY: 'true' }).MASTRA_OBSERVABILITY).toBe(true)
    expect(parseEnv({ MASTRA_OBSERVABILITY: 'false' }).MASTRA_OBSERVABILITY).toBe(false)
    expect(parseEnv({}).MASTRA_OBSERVABILITY).toBe(false)
  })

  it('defaults the observational-memory kill-switch to on', () => {
    expect(parseEnv({}).CRUM_OM_ENABLED).toBe(true)
    expect(parseEnv({ CRUM_OM_ENABLED: 'false' }).CRUM_OM_ENABLED).toBe(false)
    expect(parseEnv({ CRUM_OM_ENABLED: '0' }).CRUM_OM_ENABLED).toBe(false)
  })

  it('promotes the memory embedder override and recall kill-switch', () => {
    expect(parseEnv({}).CRUM_RECALL_ENABLED).toBe(true)
    expect(parseEnv({ CRUM_RECALL_ENABLED: 'false' }).CRUM_RECALL_ENABLED).toBe(false)
    expect(parseEnv({ MASTRA_MEMORY_EMBEDDER: 'openai/text-embedding-3-large' })
      .MASTRA_MEMORY_EMBEDDER).toBe('openai/text-embedding-3-large')
    expect(parseEnv({ MASTRA_MEMORY_EMBEDDER: '' }).MASTRA_MEMORY_EMBEDDER).toBeUndefined()
    // Promotion means both halves: parsed now, and no longer parked as deferred.
    expect(parseEnv({}).MASTRA_MEMORY_EMBEDDER).toBeUndefined()
    expect(DEFERRED_ENV_VARS).not.toHaveProperty('MASTRA_MEMORY_EMBEDDER')
  })

  it('rejects a pool max that would exceed the Supabase budget', () => {
    // 3 pools x max must stay under Supabase's session-pooler cap of 15.
    expect(() => parseEnv({ MASTRA_PG_POOL_MAX: '6' })).toThrowError(EnvParseError)
  })

  it('rejects a non-numeric pool max rather than silently defaulting', () => {
    expect(() => parseEnv({ MASTRA_PG_POOL_MAX: 'lots' })).toThrowError(EnvParseError)
  })

  it('rejects an unknown NODE_ENV', () => {
    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrowError(EnvParseError)
  })

  it('rejects a short HMAC secret', () => {
    expect(() => parseEnv({ APPROVAL_HMAC_SECRET: 'too-short' })).toThrowError(EnvParseError)
  })

  it('carries the zod issues on the thrown error', () => {
    try {
      parseEnv({ NODE_ENV: 'staging' })
      expect.unreachable('parseEnv should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(EnvParseError)
      expect((error as EnvParseError).issues.length).toBeGreaterThan(0)
      expect((error as EnvParseError).message).toContain('NODE_ENV')
    }
  })

  it('never stores a browser-prefixed variable in the server env object', () => {
    // §13.6. A NEXT_PUBLIC_ value is compiled into the client bundle. If it also
    // appears here, some server code is reading a value that is public.
    const env = parseEnv({ NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co' })
    expect(Object.keys(env).filter((k) => k.startsWith('NEXT_PUBLIC_'))).toEqual([])
  })
})

describe('production readiness', () => {
  it('names the production-required secrets', () => {
    expect(PRODUCTION_REQUIRED_SECRETS).toContain('DATABASE_URL')
    expect(PRODUCTION_REQUIRED_SECRETS).toContain('MCP_REQUEST_STATE_KEY')
    expect(PRODUCTION_REQUIRED_SECRETS).toContain('APPROVAL_HMAC_SECRET')
  })

  it('reports every missing secret on an empty environment', () => {
    const missing = missingProductionSecrets(parseEnv({}))
    expect(missing.sort()).toEqual([...PRODUCTION_REQUIRED_SECRETS].sort())
  })

  it('reports nothing when every secret is present', () => {
    const env = parseEnv({
      DATABASE_URL: 'postgresql://u:p@host:5432/db',
      OPENROUTER_API_KEY: 'or-' + 'x'.repeat(40),
      APPROVAL_HMAC_SECRET: 'a'.repeat(32),
      MCP_REQUEST_STATE_KEY: 'b'.repeat(32),
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'sr-' + 'y'.repeat(40),
      CRUM_CLOUDFLARE_API_TOKEN: 't'.repeat(40),
      CRUM_REPLICATE_API_TOKEN: 'r8-' + 'z'.repeat(40),
    })
    expect(missingProductionSecrets(env)).toEqual([])
  })

  it('only enforces the list in production', () => {
    expect(isProduction(parseEnv({ NODE_ENV: 'production', CRUM_AUTH_MODE: 'jwt' }))).toBe(true)
    expect(isProduction(parseEnv({ NODE_ENV: 'development' }))).toBe(false)
    expect(isProduction(parseEnv({ NODE_ENV: 'test' }))).toBe(false)
  })
})

describe('marketing slice 2 settings', () => {
  it('leaves the page host unset rather than inventing a default', () => {
    // The four Pages keys have no defaults on purpose: the adapters register only
    // when every one of them is really present (pageHostConfigFromEnv), and a
    // schema default would make a half-configured host look complete.
    const env = parseEnv({})
    expect(env.CRUM_CLOUDFLARE_ACCOUNT_ID).toBeUndefined()
    expect(env.CRUM_CLOUDFLARE_PAGES_PROJECT).toBeUndefined()
    expect(env.CRUM_CLOUDFLARE_API_TOKEN).toBeUndefined()
    expect(env.CRUM_PAGES_PRODUCTION_BRANCH).toBeUndefined()
    expect(env.CRUM_MARKETING_SITE_ORIGIN).toBeUndefined()
    expect(env.CRUM_LEAD_API_ORIGIN).toBeUndefined()
  })

  it('treats a blank Pages value as absent, because an empty string is not a credential', () => {
    expect(parseEnv({ CRUM_CLOUDFLARE_ACCOUNT_ID: '' }).CRUM_CLOUDFLARE_ACCOUNT_ID).toBeUndefined()
  })

  it('treats a blank Pages token as absent, not as a failed boot', () => {
    // An `.env.example` placeholder line is `KEY=`, and an unconfigured install
    // must still boot without the Pages lane.
    expect(parseEnv({ CRUM_CLOUDFLARE_API_TOKEN: '' }).CRUM_CLOUDFLARE_API_TOKEN).toBeUndefined()
    expect(parseEnv({ CRUM_CLOUDFLARE_API_TOKEN: '   ' }).CRUM_CLOUDFLARE_API_TOKEN).toBeUndefined()
  })

  it('treats a blank lead cap as unset, not as a cap of zero', () => {
    expect(parseEnv({ CRUM_MARKETING_LEAD_DAILY_CAP: '' }).CRUM_MARKETING_LEAD_DAILY_CAP).toBe(200)
    expect(parseEnv({ CRUM_MARKETING_LEAD_DAILY_CAP: '   ' }).CRUM_MARKETING_LEAD_DAILY_CAP).toBe(200)
  })

  it('rejects a Pages token too short to be a secret, like the other HMAC keys', () => {
    expect(() => parseEnv({ CRUM_CLOUDFLARE_API_TOKEN: 'short' })).toThrowError(EnvParseError)
    expect(parseEnv({ CRUM_CLOUDFLARE_API_TOKEN: 't'.repeat(40) }).CRUM_CLOUDFLARE_API_TOKEN)
      .toBe('t'.repeat(40))
  })

  it('defaults the lead cap to 200 and coerces a configured one', () => {
    expect(parseEnv({}).CRUM_MARKETING_LEAD_DAILY_CAP).toBe(200)
    expect(parseEnv({ CRUM_MARKETING_LEAD_DAILY_CAP: '500' }).CRUM_MARKETING_LEAD_DAILY_CAP).toBe(500)
  })

  it('refuses a lead cap that would either drop every lead or let the form flood', () => {
    // A page visitor is never shown the rate limit, so a cap of 0 would read as a
    // working form that silently discards every lead.
    expect(() => parseEnv({ CRUM_MARKETING_LEAD_DAILY_CAP: '0' })).toThrowError(EnvParseError)
    expect(() => parseEnv({ CRUM_MARKETING_LEAD_DAILY_CAP: '100001' })).toThrowError(EnvParseError)
    expect(() => parseEnv({ CRUM_MARKETING_LEAD_DAILY_CAP: '1.5' })).toThrowError(EnvParseError)
  })

  it('names the Pages token as a production-required secret', () => {
    expect(PRODUCTION_REQUIRED_SECRETS).toContain('CRUM_CLOUDFLARE_API_TOKEN')
    const missing = missingProductionSecrets(parseEnv({ CRUM_CLOUDFLARE_ACCOUNT_ID: 'acc' }))
    expect(missing).toContain('CRUM_CLOUDFLARE_API_TOKEN')
  })
})

describe('slice 4 image settings', () => {
  it('defaults the ceiling, the estimate and the model when nothing is set', () => {
    const env = parseEnv({ NODE_ENV: 'development' })
    expect(env.CRUM_REPLICATE_API_TOKEN).toBeUndefined()
    expect(env.CRUM_IMAGE_SPEND_CEILING_MINOR).toBe(2000)
    expect(env.CRUM_IMAGE_COST_MINOR_PER_IMAGE).toBe(4)
    // Two assertions on one value, each catching something the other cannot. The
    // literal pins the model spec section 11 names, because this string is what
    // reaches Replicate's model field and a shorter alias would not be refused by
    // anything. The constant pins the agreement with the adapter's own fallback
    // (`src/marketing/replicate.ts:11`, used at `image-provider.ts:42`): two
    // spellings of one vendor default is how `provider: REPLICATE_PROVIDER` was
    // written down in Task 6, for the same reason.
    expect(env.CRUM_REPLICATE_MODEL).toBe(DEFAULT_REPLICATE_MODEL)
    expect(DEFAULT_REPLICATE_MODEL).toBe('black-forest-labs/flux-1.1-pro')
  })

  it('treats a blank token as unset rather than as a token of length zero', () => {
    // Blank means unset for the numbers too, and not only because it is the house
    // style (`:171` does this for the lead cap): the `.env.example` placeholder
    // lines Step 3 writes are `KEY=`, so a blank ceiling that reached `.min(1)`
    // would refuse to boot an install that configured nothing.
    expect(parseEnv({ CRUM_REPLICATE_API_TOKEN: '   ' }).CRUM_REPLICATE_API_TOKEN).toBeUndefined()
    expect(parseEnv({ CRUM_IMAGE_SPEND_CEILING_MINOR: '' }).CRUM_IMAGE_SPEND_CEILING_MINOR).toBe(2000)
  })

  it('refuses a ceiling that is not a positive whole number of minor units', () => {
    // '1.5' is the case that matters: a fractional ceiling would otherwise reach
    // `admitsRun` as a float and compare against integer minors, which is the
    // arithmetic the spend ledger is supposed to be free of.
    expect(() => parseEnv({ CRUM_IMAGE_SPEND_CEILING_MINOR: '0' })).toThrowError(EnvParseError)
    expect(() => parseEnv({ CRUM_IMAGE_SPEND_CEILING_MINOR: '1.5' })).toThrowError(EnvParseError)
    expect(() => parseEnv({ CRUM_IMAGE_SPEND_CEILING_MINOR: 'abc' })).toThrowError(EnvParseError)
  })
  it('defaults the per-bundle ceiling to 200 and coerces a configured one', () => {
    expect(parseEnv({}).CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE).toBe(200)
    expect(parseEnv({ CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE: '50' }).CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE).toBe(50)
    // Blank means unset, like every other blankAsUnset key.
    expect(parseEnv({ CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE: '' }).CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE).toBe(200)
  })

  it('refuses a bundle ceiling that is not a positive whole number of minor units', () => {
    expect(() => parseEnv({ CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE: '0' })).toThrowError(EnvParseError)
    expect(() => parseEnv({ CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE: '1.5' })).toThrowError(EnvParseError)
    expect(() => parseEnv({ CRUM_IMAGE_SPEND_CEILING_MINOR_PER_BUNDLE: 'abc' })).toThrowError(EnvParseError)
  })
})

describe('.env.example is the contract', () => {
  const documented = documentedNames()

  it('documents every variable the schema parses', () => {
    const parsed = Object.keys(EnvSchema.shape)
    const undocumented = parsed.filter((name) => !documented.includes(name))
    expect(undocumented).toEqual([])
  })

  it('either parses or explicitly defers every variable it documents', () => {
    // A variable in .env.example that nothing reads is a lie to whoever copies
    // the file. Each one is either in the schema or named in DEFERRED_ENV_VARS
    // with the phase that will read it.
    const parsed = new Set(Object.keys(EnvSchema.shape))
    const unaccounted = documented.filter((n) => !parsed.has(n) && !(n in DEFERRED_ENV_VARS))
    expect(unaccounted).toEqual([])
  })

  it('defers every listed variable to a real phase', () => {
    for (const [name, phase] of Object.entries(DEFERRED_ENV_VARS)) {
      expect(phase, name).toBeGreaterThanOrEqual(1)
      expect(phase, name).toBeLessThanOrEqual(7)
    }
  })

  it('documents no secret value, only a placeholder', () => {
    const lines = readFileSync(join(process.cwd(), '.env.example'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    const examined: string[] = []
    for (const line of lines) {
      // Split on the FIRST '=' only. `line.split('=')` destructured to
      // `[name, value]` hands back the segment between the first and second '=',
      // so any credential containing '=' padding would be checked only up to its
      // first internal '=' and the rest never seen.
      const eq = line.indexOf('=')
      const name = line.slice(0, eq).trim()
      const value = line.slice(eq + 1)
      // The secret noun has to be the name's LAST segment. A substring search
      // flags RUNS_APPROVAL_TOKEN_TTL_SECONDS — a duration in seconds, not a
      // credential — purely because "TOKEN" appears mid-name, and fails the
      // build on a correct file. dotenv convention puts the noun last;
      // DATABASE_URL is the one secret whose name does not, so it is named.
      const secretish =
        /(^|_)(KEY|KEYS|SECRET|SECRETS|PASSWORD|TOKEN|TOKENS)$/.test(name) || name === 'DATABASE_URL'
      if (!secretish) continue
      examined.push(name)
      // Placeholders only. A real credential here is committed forever.
      expect(value, `${name} looks like a real value`).toMatch(
        /^(your_|changeme|replace_|postgresql:\/\/user:password@|https:\/\/|\$\{|$)/,
      )
    }
    // Non-vacuity. A loop that examines nothing passes, so if every secret is
    // ever renamed out of the pattern above this test goes silently empty
    // instead of red. DATABASE_URL is named because it is the one branch the
    // explicit special case exists to cover.
    expect(examined.length, 'no .env.example name matched the secret pattern').toBeGreaterThan(0)
    expect(examined, 'the DATABASE_URL special case is never exercised').toContain('DATABASE_URL')
  })

  it('warns against browser exposure of server secrets', () => {
    const text = readFileSync(join(process.cwd(), '.env.example'), 'utf8')
    expect(text).toContain('Never copy SUPABASE_SERVICE_ROLE_KEY or DATABASE_URL into a browser')
  })
})
