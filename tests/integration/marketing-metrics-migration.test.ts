// tests/integration/marketing-metrics-migration.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''

let pool: Pool

describe.skipIf(!url)('migration 0020: marketing_metrics_snapshots', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 })
    await migrate(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  it('creates the marketing_metrics_snapshots table with the right columns', async () => {
    const { rows } = await pool.query<Record<string, string>>(`
      SELECT column_name, data_type, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'marketing_metrics_snapshots'
      ORDER BY ordinal_position
    `)

    expect(rows).toHaveLength(8)
    expect(rows.map((r) => r.column_name)).toEqual([
      'id',
      'tenant_id',
      'bundle_id',
      'campaign_external_id',
      'window_start',
      'window_end',
      'metrics',
      'created_at',
    ])

    const metricsCol = rows.find((r) => r.column_name === 'metrics')
    expect(metricsCol?.data_type).toBe('jsonb')
    expect(metricsCol?.udt_name).toBe('jsonb')

    const idCol = rows.find((r) => r.column_name === 'id')
    expect(idCol?.is_nullable).toBe('NO')

    const tenantCol = rows.find((r) => r.column_name === 'tenant_id')
    expect(tenantCol?.is_nullable).toBe('NO')
  })

  it('has a primary key on id', async () => {
    const { rows } = await pool.query<Record<string, string>>(`
      SELECT conname, contype
      FROM pg_constraint
      WHERE conrelid = 'marketing_metrics_snapshots'::regclass
        AND contype = 'p'
    `)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.conname).toMatch(/^pk_marketing_metrics_snapshots/)
  })
})
