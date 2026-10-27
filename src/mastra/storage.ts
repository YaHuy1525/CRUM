import type { ConnectionOptions } from 'node:tls'
import { InMemoryStore } from '@mastra/core/storage'
import { PostgresStoreVNext } from '@mastra/pg'
import { isProduction, POOL_COUNT, SUPABASE_POOL_SIZE } from '../config/env'
import type { CrumEnv } from '../config/env'

export type CrumStorage = PostgresStoreVNext | InMemoryStore

export const STORAGE_ID = 'crum'

export class StorageConfigError extends Error {
  readonly variables: readonly string[]

  constructor(message: string, variables: readonly string[] = []) {
    super(message)
    this.name = 'StorageConfigError'
    this.variables = variables
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

const TLS_ON: ConnectionOptions = { rejectUnauthorized: true }

export function hostOf(connectionString: string): string | undefined {
  try {
    return new URL(connectionString).hostname
  } catch {
    return undefined
  }
}

export function isLocalDatabaseUrl(connectionString: string | undefined): boolean {
  if (!connectionString) return false
  const host = hostOf(connectionString)
  return host !== undefined && LOCAL_HOSTS.has(host)
}

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

export function observabilityConnectionString(env: CrumEnv): string | undefined {
  return env.OBSERVABILITY_DATABASE_URL ?? env.DATABASE_URL
}

export function isPostgresStorage(storage: CrumStorage): storage is PostgresStoreVNext {
  return storage instanceof PostgresStoreVNext
}

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
    disableInit: env.MASTRA_DB_DISABLE_INIT,
    observability: {
      connectionString: observabilityUrl,
      ssl: resolveSsl(observabilityUrl, env.MASTRA_PG_SSL),
      max,
    },
  })
}
