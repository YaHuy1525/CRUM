import { Pool } from 'pg'
import { parseEnv } from '../config/env'

let pool: Pool | null = null

/**
 * The one-parameter read shape a data module takes when it must be able to run
 * either on the pool or inside somebody else's transaction. `Pool` satisfies it,
 * so a caller can pass `getDbClient()` or a client it checked out; naming it here
 * is what keeps the fourth module that needs it from re-spelling the structural
 * type and drifting from the first three.
 */
export interface Queryable {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>
}

export function getDbClient(): Pool {
  if (pool) return pool

  const env = parseEnv()
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set in the environment')
  }

  pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  })

  return pool
}

export async function closeDbClient(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
