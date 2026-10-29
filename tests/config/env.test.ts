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
    const env = parseEnv({ MASTRA_PG_POOL_MAX: '7', RATE_LIMIT_PER_MINUTE: '300' })
    expect(env.MASTRA_PG_POOL_MAX).toBe(7)
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
    // 2 pools x max must stay under Supabase's session-pooler cap of 15.
    expect(() => parseEnv({ MASTRA_PG_POOL_MAX: '9' })).toThrowError(EnvParseError)
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
    })
    expect(missingProductionSecrets(env)).toEqual([])
  })

  it('only enforces the list in production', () => {
    expect(isProduction(parseEnv({ NODE_ENV: 'production', CRUM_AUTH_MODE: 'jwt' }))).toBe(true)
    expect(isProduction(parseEnv({ NODE_ENV: 'development' }))).toBe(false)
    expect(isProduction(parseEnv({ NODE_ENV: 'test' }))).toBe(false)
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
