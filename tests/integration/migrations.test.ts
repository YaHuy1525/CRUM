import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { main, migrate } from '../../scripts/db-migrate'

/**
 * Integration tests need a real PostgreSQL. Without one they skip rather than
 * fail, so `npm run test` stays green on a laptop with no database. CI sets this
 * from the pgvector service container. §14.2.
 */
const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''

function openPool(): Pool {
  return new Pool({ connectionString: url, max: 2 })
}

const pools: Pool[] = []

function tracked(): Pool {
  const pool = openPool()
  pools.push(pool)
  return pool
}

afterAll(async () => {
  while (pools.length > 0) {
    const pool = pools.pop()
    if (pool) await pool.end()
  }
})

const SPINE_TABLES = [
  'customers',
  'contacts',
  'followups',
  'tasks',
  'schedules',
  'knowledge_documents',
  'pending_writes',
  'audit_receipts',
  'human_tasks',
  'crum_schema_migrations',
]

describe.skipIf(url === '')('migrations against a real database', () => {
  it('boots through main(), which runs storage.init() and then the spine', async () => {
    const result = await main({
      NODE_ENV: 'development',
      DATABASE_URL: url,
      MASTRA_DB_DISABLE_INIT: 'true',
    } as NodeJS.ProcessEnv)

    expect(result.applied).toContain('0002_crum_spine.sql')

    const pool = tracked()
    const found = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    )
    const names = found.rows.map((row) => row.table_name)
    for (const table of SPINE_TABLES) {
      expect(names, table).toContain(table)
    }
  }, 120_000)

  it('is a no-op the second time', async () => {
    const pool = tracked()
    const result = await migrate(pool)
    expect(result.applied).toEqual([])
    expect(result.skipped).toContain('0002_crum_spine.sql')
  })

  it('refuses to insert a customer without a tenant', async () => {
    const pool = tracked()
    await expect(
      pool.query(`INSERT INTO customers (name, owner_id) VALUES ('No Tenant', gen_random_uuid())`),
    ).rejects.toThrow(/null value in column "tenant_id"/)
  })

  it('refuses a schedule that ends before it starts', async () => {
    const pool = tracked()
    await expect(
      pool.query(
        `INSERT INTO schedules (tenant_id, title, start_time, end_time, owner_id)
         VALUES (gen_random_uuid(), 'Backwards', now(), now() - interval '1 hour', gen_random_uuid())`,
      ),
    ).rejects.toThrow(/schedules_end_after_start/)
  })

  it('refuses a second receipt for the same staged draft', async () => {
    const pool = tracked()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const tenant = (await client.query(`SELECT gen_random_uuid() AS id`)).rows[0]?.id as string
      const requester = (await client.query(`SELECT gen_random_uuid() AS id`)).rows[0]?.id as string
      const draft = await client.query<{ id: string }>(
        `INSERT INTO pending_writes
           (tenant_id, run_id, object_type, operation, payload, risk_score, gate, requested_by, expires_at)
         VALUES ($1, 'run-test', 'customer', 'create', '{}'::jsonb, 60, 'approval', $2, now() + interval '1 hour')
         RETURNING id`,
        [tenant, requester],
      )
      const draftId = draft.rows[0]?.id as string

      await client.query(
        `INSERT INTO audit_receipts (tenant_id, pending_write_id, run_id, signature, approved_by, decision)
         VALUES ($1, $2, 'run-test', 'sig-1', $3, 'approved')`,
        [tenant, draftId, requester],
      )

      await expect(
        client.query(
          `INSERT INTO audit_receipts (tenant_id, pending_write_id, run_id, signature, approved_by, decision)
           VALUES ($1, $2, 'run-test', 'sig-2', $3, 'rejected')`,
          [tenant, draftId, requester],
        ),
      ).rejects.toThrow(/uq_receipts_draft/)

      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('rejects a migration edited after it was applied', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'crum-migrations-'))
    const file = path.join(dir, '9101_crum_probe.sql')
    const pool = tracked()

    try {
      await writeFile(
        file,
        'CREATE TABLE IF NOT EXISTS crum_probe_9101 (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)',
        'utf8',
      )
      const first = await migrate(pool, dir)
      expect(first.applied).toEqual(['9101_crum_probe.sql'])

      await writeFile(
        file,
        'CREATE TABLE IF NOT EXISTS crum_probe_9101 (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, extra text)',
        'utf8',
      )
      await expect(migrate(pool, dir)).rejects.toThrow(/changed after it was applied/)
    } finally {
      await pool.query(`DROP TABLE IF EXISTS crum_probe_9101`)
      await pool.query(`DELETE FROM crum_schema_migrations WHERE version = '9101'`)
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('without a database', () => {
  it('main() refuses to migrate in-memory storage', async () => {
    await expect(main({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).rejects.toThrow(
      /DATABASE_URL is required to migrate/,
    )
  })
})
