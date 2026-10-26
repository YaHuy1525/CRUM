import { Pool } from 'pg'
import { parseEnv } from '../config/env'

let pool: Pool | null = null

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
