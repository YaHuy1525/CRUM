import type { ConnectionOptions } from 'node:tls'
import { InMemoryStore } from '@mastra/core/storage'
import { PostgresStoreVNext } from '@mastra/pg'
import { isProduction, POOL_COUNT, SUPABASE_POOL_SIZE } from '../config/env'
import type { CrumEnv } from '../config/env'

/**
 * The store CRUM hands to `new Mastra({ storage })`. Postgres when configured,
 * in-memory otherwise, so `npm run dev` works with no Supabase project (§14.4).
 */
export type CrumStorage = PostgresStoreVNext | InMemoryStore

/** The store id. Mastra uses it for schema isolation and log attribution. */
export const STORAGE_ID = 'crum'

/**
 * Thrown when storage cannot be configured safely. `variables` carries the names
 * of the offending environment variables and never their values, so the message
 * is safe to log and safe to surface to a deployer.
 */
export class StorageConfigError extends Error {
  readonly variables: readonly string[]

  constructor(message: string, variables: readonly string[] = []) {
    super(message)
    this.name = 'StorageConfigError'
    this.variables = variables
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Exact TLS configuration CRUM asks node-postgres for. */
const TLS_ON: ConnectionOptions = { rejectUnauthorized: true }

export function hostOf(connectionString: string): string | undefined {
  try {
    return new URL(connectionString).hostname
  } catch {
    return undefined
  }
}

/**
 * True only for an exact loopback hostname. This is a set membership test and
 * deliberately not a substring test: `localhost.evil.example` must not be
 * treated as loopback, because that decision disables TLS.
 */
export function isLocalDatabaseUrl(connectionString: string | undefined): boolean {
  if (!connectionString) return false
  const host = hostOf(connectionString)
  return host !== undefined && LOCAL_HOSTS.has(host)
}

/**
 * §9.1: TLS is mandatory for anything that is not loopback. A plaintext
 * connection to a managed Postgres puts the credentials inside DATABASE_URL and
 * every customer row on the wire.
 *
 * `rejectUnauthorized: true` is stated explicitly rather than relying on
 * `ssl: true`, because the effective default has not been stable across Node and
 * node-postgres versions and this is a security control.
 *
 * MASTRA_PG_SSL overrides in both directions: `true` forces TLS against loopback
 * (a local tunnel or a container behind stunnel), `false` disables it (a
 * corporate MITM proxy). A self-signed certificate should be fixed by adding the
 * signing CA to NODE_EXTRA_CA_CERTS, not by turning verification off.
 */
export function resolveSsl(
  connectionString: string | undefined,
  override: 'true' | 'false' | undefined,
): boolean | ConnectionOptions {
  if (override === 'false') return false
  if (override === 'true') return TLS_ON
  if (isLocalDatabaseUrl(connectionString)) return false
  return TLS_ON
}

export function pgPoolMax(env: CrumEnv): number {
  return env.MASTRA_PG_POOL_MAX
}

export interface PoolBudget {
  pools: number
  perPoolMax: number
  total: number
  limit: number
  ok: boolean
}

/**
 * Supabase's session-mode pooler accepts 15 clients in total.
 * PostgresStoreVNext holds a writer pool, and `readPool` falls back to that
 * writer when unset (pg-storage.d.ts:89-90), plus a separate observability pool.
 * So POOL_COUNT is 2 and the per-pool cap must satisfy 2 x max <= 15.
 *
 * EnvSchema already rejects a value above floor(15 / 2) = 7. This recomputes the
 * same invariant from the exported constants so that raising the cap without
 * raising POOL_COUNT fails a test here instead of failing in production as
 * EMAXCONNSESSION, which reads like a database outage and is not one.
 */
export function checkPoolBudget(env: CrumEnv): PoolBudget {
  const perPoolMax = pgPoolMax(env)
  const total = POOL_COUNT * perPoolMax
  return {
    pools: POOL_COUNT,
    perPoolMax,
    total,
    limit: SUPABASE_POOL_SIZE,
    ok: total <= SUPABASE_POOL_SIZE,
  }
}

/**
 * The observability connection PostgresStoreVNext demands. Phase 0 runs with
 * MASTRA_OBSERVABILITY=false, so nothing is written here yet, but the
 * constructor still requires the field. Falling back to DATABASE_URL keeps local
 * setup to one URL and costs a logged warning; production should set a separate
 * database before observability is switched on. §9.1, §14.3.
 */
export function observabilityConnectionString(env: CrumEnv): string | undefined {
  return env.OBSERVABILITY_DATABASE_URL ?? env.DATABASE_URL
}

export function isPostgresStorage(storage: CrumStorage): storage is PostgresStoreVNext {
  return storage instanceof PostgresStoreVNext
}

/**
 * Builds the storage adapter for a parsed environment. Never reads process.env
 * itself: the caller parses once and passes the result, so a test can supply an
 * exact environment and nothing leaks from the developer's shell.
 *
 * Throws StorageConfigError rather than degrading when production has no
 * DATABASE_URL. In-memory storage in production means every customer, every
 * pending write and every approval receipt vanishes on restart, and a CRM that
 * silently forgets its audit trail is worse than one that refuses to start.
 * This is one of the two fail-closed exceptions in §13.8.
 */
export function buildMastraStorage(env: CrumEnv): CrumStorage {
  const connectionString = env.DATABASE_URL

  if (!connectionString) {
    if (isProduction(env)) {
      throw new StorageConfigError(
        'production requires DATABASE_URL; refusing to boot on ephemeral in-memory storage',
        ['DATABASE_URL'],
      )
    }
    return new InMemoryStore({ id: STORAGE_ID })
  }

  const budget = checkPoolBudget(env)
  if (!budget.ok) {
    throw new StorageConfigError(
      `pool budget exceeded: ${budget.pools} pools x max ${budget.perPoolMax} = ${budget.total} clients, Supabase pool_size is ${budget.limit}`,
      ['MASTRA_PG_POOL_MAX'],
    )
  }

  const observabilityUrl = observabilityConnectionString(env)
  if (!observabilityUrl) {
    throw new StorageConfigError(
      'PostgresStoreVNext requires an observability connection; set OBSERVABILITY_DATABASE_URL or DATABASE_URL',
      ['OBSERVABILITY_DATABASE_URL', 'DATABASE_URL'],
    )
  }

  const max = pgPoolMax(env)

  return new PostgresStoreVNext({
    id: STORAGE_ID,
    connectionString,
    ssl: resolveSsl(connectionString, env.MASTRA_PG_SSL),
    max,
    // true by default. Runtime must never create or alter tables; migrations run
    // explicitly through scripts/db-migrate.ts, which constructs with false. §14.2.
    disableInit: env.MASTRA_DB_DISABLE_INIT,
    observability: {
      connectionString: observabilityUrl,
      ssl: resolveSsl(observabilityUrl, env.MASTRA_PG_SSL),
      max,
    },
  })
}
