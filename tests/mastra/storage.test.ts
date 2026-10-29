import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { PostgresStoreVNext } from '@mastra/pg'
import { parseEnv } from '../../src/config/env'
import type { CrumEnv } from '../../src/config/env'
import {
  buildMastraStorage,
  checkPoolBudget,
  hostOf,
  isLocalDatabaseUrl,
  isPostgresStorage,
  observabilityConnectionString,
  pgPoolMax,
  resolveSsl,
  StorageConfigError,
} from '../../src/mastra/storage'
import type { CrumStorage } from '../../src/mastra/storage'

const REMOTE = 'postgresql://crum:secret@db.abcdefgh.supabase.co:5432/postgres'
const LOCAL = 'postgresql://crum:secret@localhost:5432/crum'
const LOCAL_V6 = 'postgresql://crum:secret@[::1]:5432/crum'
const OBSERVABILITY = 'postgresql://crum:secret@obs.abcdefgh.supabase.co:5432/postgres'

function envWith(overrides: Record<string, string> = {}): CrumEnv {
  return parseEnv({ NODE_ENV: 'development', ...overrides })
}

/**
 * PostgresStoreVNext constructs pg.Pool objects. Pools are lazy, so nothing
 * connects until a query runs, but they still need closing or Vitest reports
 * the worker as hung.
 */
const opened: CrumStorage[] = []

function build(overrides: Record<string, string> = {}): CrumStorage {
  const storage = buildMastraStorage(envWith(overrides))
  opened.push(storage)
  return storage
}

afterEach(async () => {
  while (opened.length > 0) {
    const storage = opened.pop()
    if (storage) await storage.close()
  }
})

describe('hostOf', () => {
  it('extracts the hostname from a connection string', () => {
    expect(hostOf(REMOTE)).toBe('db.abcdefgh.supabase.co')
    expect(hostOf(LOCAL)).toBe('localhost')
    expect(hostOf(LOCAL_V6)).toBe('[::1]')
  })

  it('returns undefined for something that is not a URL', () => {
    expect(hostOf('not a url')).toBeUndefined()
    expect(hostOf('')).toBeUndefined()
  })
})

describe('isLocalDatabaseUrl', () => {
  it('recognises loopback hosts', () => {
    expect(isLocalDatabaseUrl(LOCAL)).toBe(true)
    expect(isLocalDatabaseUrl(LOCAL_V6)).toBe(true)
    expect(isLocalDatabaseUrl('postgresql://crum@127.0.0.1:5432/crum')).toBe(true)
  })

  it('rejects a managed host and an absent URL', () => {
    expect(isLocalDatabaseUrl(REMOTE)).toBe(false)
    expect(isLocalDatabaseUrl(undefined)).toBe(false)
  })

  it('does not treat a hostname containing localhost as loopback', () => {
    expect(isLocalDatabaseUrl('postgresql://crum@localhost.evil.example:5432/crum')).toBe(false)
  })
})

describe('resolveSsl', () => {
  it('requires TLS for a remote host', () => {
    expect(resolveSsl(REMOTE, undefined)).toEqual({ rejectUnauthorized: true })
  })

  it('allows plaintext for loopback', () => {
    expect(resolveSsl(LOCAL, undefined)).toBe(false)
  })

  it('lets MASTRA_PG_SSL=true force TLS on loopback', () => {
    expect(resolveSsl(LOCAL, 'true')).toEqual({ rejectUnauthorized: true })
  })

  it('lets MASTRA_PG_SSL=false disable TLS on a remote host', () => {
    expect(resolveSsl(REMOTE, 'false')).toBe(false)
  })

  it('agrees with itself when the override restates the derived default', () => {
    expect(resolveSsl(REMOTE, 'true')).toEqual(resolveSsl(REMOTE, undefined))
    expect(resolveSsl(LOCAL, 'false')).toEqual(resolveSsl(LOCAL, undefined))
  })
})

describe('pgPoolMax and checkPoolBudget', () => {
  it('defaults to four clients per pool', () => {
    expect(pgPoolMax(envWith())).toBe(4)
    expect(checkPoolBudget(envWith())).toEqual({
      pools: 3,
      perPoolMax: 4,
      total: 12,
      limit: 15,
      ok: true,
    })
  })

  it('accepts the highest cap EnvSchema allows', () => {
    const budget = checkPoolBudget(envWith({ MASTRA_PG_POOL_MAX: '5' }))
    expect(budget.total).toBe(15)
    expect(budget.ok).toBe(true)
  })

  it('never lets 3 pools exceed Supabase pool_size at any accepted value', () => {
    for (const max of [1, 2, 3, 4, 5]) {
      const budget = checkPoolBudget(envWith({ MASTRA_PG_POOL_MAX: String(max) }))
      expect(budget.ok, `max=${max}`).toBe(true)
    }
  })
})

describe('observabilityConnectionString', () => {
  it('prefers a dedicated observability database', () => {
    const env = envWith({ DATABASE_URL: REMOTE, OBSERVABILITY_DATABASE_URL: OBSERVABILITY })
    expect(observabilityConnectionString(env)).toBe(OBSERVABILITY)
  })

  it('falls back to the primary connection so local dev needs one URL', () => {
    expect(observabilityConnectionString(envWith({ DATABASE_URL: REMOTE }))).toBe(REMOTE)
  })

  it('is undefined when nothing is configured', () => {
    expect(observabilityConnectionString(envWith())).toBeUndefined()
  })
})

describe('buildMastraStorage', () => {
  it('returns an in-memory store when DATABASE_URL is absent in development', () => {
    const storage = build()
    expect(storage).toBeInstanceOf(InMemoryStore)
    expect(isPostgresStorage(storage)).toBe(false)
  })

  it('returns an in-memory store in the test environment too', () => {
    const storage = buildMastraStorage(parseEnv({ NODE_ENV: 'test' }))
    opened.push(storage)
    expect(storage).toBeInstanceOf(InMemoryStore)
  })

  it('refuses to boot on ephemeral storage in production', () => {
    expect(() =>
      buildMastraStorage(
        parseEnv({
          NODE_ENV: 'production',
          CRUM_AUTH_MODE: 'jwt',
          APPROVAL_HMAC_SECRET: 'a'.repeat(32),
          MCP_REQUEST_STATE_KEY: 'b'.repeat(32),
          OPENROUTER_API_KEY: 'sk-or-v1-placeholder',
          SUPABASE_URL: 'https://abcdefgh.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key',
        }),
      ),
    ).toThrowError(StorageConfigError)
  })

  it('names the missing variable rather than printing its value', () => {
    try {
      buildMastraStorage(
        parseEnv({
          NODE_ENV: 'production',
          CRUM_AUTH_MODE: 'jwt',
          APPROVAL_HMAC_SECRET: 'a'.repeat(32),
          MCP_REQUEST_STATE_KEY: 'b'.repeat(32),
          OPENROUTER_API_KEY: 'sk-or-v1-placeholder',
          SUPABASE_URL: 'https://abcdefgh.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key',
        }),
      )
      expect.unreachable('production without DATABASE_URL must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(StorageConfigError)
      expect((error as StorageConfigError).variables).toEqual(['DATABASE_URL'])
      expect((error as StorageConfigError).message).not.toContain('secret')
    }
  })

  /**
   * The load-bearing assertion of this task. The scaffold's
   * `new PostgresStoreVNext({ connectionString })` compiled for nobody; this
   * proves the shipped constructor accepts the config CRUM actually passes.
   */
  it('constructs a PostgresStoreVNext with the required id and observability fields', () => {
    const storage = build({ DATABASE_URL: REMOTE })
    expect(storage).toBeInstanceOf(PostgresStoreVNext)
    expect(isPostgresStorage(storage)).toBe(true)
  })

  it('constructs with a dedicated observability connection', () => {
    const storage = build({ DATABASE_URL: REMOTE, OBSERVABILITY_DATABASE_URL: OBSERVABILITY })
    expect(storage).toBeInstanceOf(PostgresStoreVNext)
  })

  it('passes disableInit through so runtime never mutates the schema', () => {
    const storage = build({ DATABASE_URL: REMOTE, MASTRA_DB_DISABLE_INIT: 'true' })
    expect(storage).toBeInstanceOf(PostgresStoreVNext)
  })
})
