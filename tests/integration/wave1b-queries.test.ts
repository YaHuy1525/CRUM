import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDbClient, closeDbClient } from '../../src/db/client'
import { queryKnowledgeDocuments, querySchedulesForDate } from '../../src/db/queries'
import type { TenantRequestContext } from '../../src/mastra/tenant-context'

/**
 * Wave 1B regression proof.
 *
 * These two query paths previously threw against real Postgres:
 *   - queryKnowledgeDocuments filtered a `content` column that 0002 does not
 *     define (title-only now).
 *   - there was no by-date schedule query; the plan's `scheduled_at` filter
 *     named a column that does not exist (date(start_time) now).
 *
 * This test seeds rows in an ephemeral tenant, runs the REAL exported functions,
 * and asserts they return rows instead of throwing. It intentionally does NOT
 * call migrate(): both functions touch only columns that exist in 0002, so the
 * proof adds no schema to the shared database. Seeded rows are removed in
 * afterAll. Skips without CRUM_INTEGRATION_DATABASE_URL. §14.2.
 */
const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''

const tenantId = randomUUID()
const userId = randomUUID()
const docId = randomUUID()
const scheduleId = randomUUID()
const title = `Wave1B Proof Doc ${tenantId.slice(0, 8)}`

const adminContext: TenantRequestContext = { tenantId, userId, userRole: 'admin' }

let pool: Pool | null = null

describe.skipIf(url === '')('Wave 1B formerly-broken queries against Postgres', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url
    pool = new Pool({ connectionString: url, max: 2 })

    await pool.query(
      `INSERT INTO knowledge_documents (id, tenant_id, title, file_type, content_hash, owner_id)
       VALUES ($1, $2, $3, 'md', $4, $5)`,
      [docId, tenantId, title, randomUUID(), userId],
    )

    await pool.query(
      `INSERT INTO schedules (id, tenant_id, title, start_time, end_time, owner_id)
       VALUES ($1, $2, 'Wave1B Proof Schedule', now(), now() + interval '1 hour', $3)`,
      [scheduleId, tenantId, userId],
    )
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM knowledge_documents WHERE id = $1`, [docId])
      await pool.query(`DELETE FROM schedules WHERE id = $1`, [scheduleId])
      await pool.end()
    }
    await closeDbClient()
  })

  it('queryKnowledgeDocuments returns the seeded row (title-only, no throw)', async () => {
    const rows = await queryKnowledgeDocuments(adminContext, 'Wave1B Proof')
    // The real singleton must have connected and returned rows.
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    const hit = rows.find((r) => r.id === docId)
    expect(hit, 'seeded knowledge document missing from results').toBeDefined()
    console.log('queryKnowledgeDocuments row:', JSON.stringify(hit))
    expect(hit?.title).toBe(title)
  })

  it('querySchedulesForDate returns the seeded row (date(start_time), no throw)', async () => {
    // Resolve the date exactly the way Postgres will cast start_time -> date.
    const dateRes = await getDbClient().query<{ d: string }>(
      `SELECT to_char(start_time, 'YYYY-MM-DD') AS d FROM schedules WHERE id = $1`,
      [scheduleId],
    )
    const day = dateRes.rows[0]?.d as string
    expect(day).toBeDefined()

    const rows = await querySchedulesForDate(adminContext, day)
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    const hit = rows.find((r) => r.id === scheduleId)
    expect(hit, 'seeded schedule missing from results').toBeDefined()
    console.log(`querySchedulesForDate(${day}) row:`, JSON.stringify(hit))
  })
})
