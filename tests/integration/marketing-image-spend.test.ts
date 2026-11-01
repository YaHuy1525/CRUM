// tests/integration/marketing-image-spend.test.ts
// The unit file proves the ceiling arithmetic with no database at all; this
// file proves the two SQL lanes of src/marketing/image-spend.ts work against
// the table migration 0021 actually built: the per-tenant, per-day committed
// read, the append-only write with its raw_extract handle, and the day the
// database stamps into spent_on itself.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { migrate } from '../../scripts/db-migrate'
import { closeDbClient } from '../../src/db/client'
import { committedSpendMinor, recordImageSpend } from '../../src/marketing/image-spend'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
// committedSpendMinor and recordImageSpend speak through getDbClient(), which
// reads DATABASE_URL lazily at first call, so pointing it at the throwaway
// cluster here is the standing pattern (tests/integration/marketing-bundle.test.ts).
if (url) process.env.DATABASE_URL = url

let pool: Pool

// This file shares the database with every other integration file and Vitest
// runs them in parallel, so every case mints its own tenant uuid instead of
// reusing the fixed one: marketing-assets-migration.test.ts writes a spend row
// for tenant 11111111-... on the same day and its cleanup is not in a finally.
// tenant_id carries no foreign key to tenants (0021), so a minted uuid is legal,
// and with a tenant nobody else touches, an absolute sum stays an exact fact
// about this file's own rows.
async function unique(): Promise<string> {
  const { rows } = await pool.query<{ n: string }>(`SELECT gen_random_uuid() AS n`)
  return rows[0]!.n
}

async function uniqueTenant(): Promise<string> {
  return await unique()
}

describe.skipIf(!url)('the image spend ledger against real Postgres', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 })
    await migrate(pool)
  })

  afterAll(async () => {
    await closeDbClient()
    await pool.end()
  })

  it('records a spend and counts it as the committed total for today', async () => {
    const tenant = await uniqueTenant()
    const doc = await unique()
    try {
      const spendId = await recordImageSpend({
        tenantId: tenant,
        documentId: doc,
        costMinor: 4,
        rawExtract: { predictionId: 'p-int-1', model: 'flux-1.1-pro', costUsd: '0.04' },
      })
      // A single spend row for this tenant makes the arithmetic exact.
      expect(await committedSpendMinor(tenant)).toBe(4)
      const { rows } = await pool.query<{
        provider: string
        cost_minor: number
        document_id: string
        raw_extract: { predictionId: string; model: string; costUsd: string }
        spent_on: string
      }>(
        `SELECT provider, cost_minor, document_id, raw_extract, spent_on::text AS spent_on
           FROM marketing_image_spend WHERE id = $1`,
        [spendId],
      )
      expect(rows[0]!.provider).toBe('replicate')
      expect(rows[0]!.cost_minor).toBe(4)
      expect(rows[0]!.document_id).toBe(doc)
      expect(rows[0]!.raw_extract).toEqual({ predictionId: 'p-int-1', model: 'flux-1.1-pro', costUsd: '0.04' })
      // The server's own today, read as text: node-pg hands a date column back
      // as a Date object and this cluster runs at UTC+11, so a UTC ISO string
      // is the wrong thing to compare CURRENT_DATE to (house pattern, 0021 file).
      const { rows: today } = await pool.query<{ d: string }>(`SELECT current_date::text AS d`)
      expect(rows[0]!.spent_on).toBe(today[0]!.d)
    } finally {
      await pool.query(`DELETE FROM marketing_image_spend WHERE tenant_id = $1`, [tenant])
    }
  })

  it('counts a zero-minor spend row rather than skipping it', async () => {
    const tenant = await uniqueTenant()
    try {
      // costUsdToMinor('0.004') is 0 (Task 3): a sub-half-cent charge is honest
      // arithmetic, and a row of it must still land in the append-only ledger
      // even though it moves the day's sum by nothing.
      const spendId = await recordImageSpend({ tenantId: tenant, documentId: null, costMinor: 0 })
      expect(await committedSpendMinor(tenant)).toBe(0)
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM marketing_image_spend WHERE id = $1`,
        [spendId],
      )
      expect(rows).toHaveLength(1)
    } finally {
      await pool.query(`DELETE FROM marketing_image_spend WHERE tenant_id = $1`, [tenant])
    }
  })

  it('keeps the spend of one tenant out of the ceiling read of another', async () => {
    const mine = await uniqueTenant()
    const other = await uniqueTenant()
    try {
      await recordImageSpend({ tenantId: mine, documentId: null, costMinor: 600 })
      await recordImageSpend({ tenantId: mine, documentId: null, costMinor: 1380 })
      await recordImageSpend({ tenantId: other, documentId: null, costMinor: 500 })
      expect(await committedSpendMinor(mine)).toBe(1980)
      expect(await committedSpendMinor(other)).toBe(500)
    } finally {
      await pool.query(`DELETE FROM marketing_image_spend WHERE tenant_id = ANY($1::uuid[])`, [[mine, other]])
    }
  })

  it('reads a tenant that has never spent as zero', async () => {
    // No row to clean up: the tenant exists only in this read.
    expect(await committedSpendMinor(await uniqueTenant())).toBe(0)
  })

  it('sums only today, so a backdated spend does not eat the new day', async () => {
    const tenant = await uniqueTenant()
    try {
      await recordImageSpend({ tenantId: tenant, documentId: null, costMinor: 40 })
      // The module deliberately exposes no spent_on parameter — an append-only
      // ledger whose caller can rewrite history is not append-only — so the
      // backdated row goes in through raw SQL to prove the read's day scoping.
      await pool.query(
        `INSERT INTO marketing_image_spend (tenant_id, document_id, provider, cost_minor, spent_on)
         VALUES ($1, NULL, 'replicate', 500, CURRENT_DATE - 1)`,
        [tenant],
      )
      expect(await committedSpendMinor(tenant)).toBe(40)
    } finally {
      await pool.query(`DELETE FROM marketing_image_spend WHERE tenant_id = $1`, [tenant])
    }
  })
})
