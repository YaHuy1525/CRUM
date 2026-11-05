import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from '../helpers/test-server.js'
import type { Pool, PoolClient } from 'pg'

const TENANT = '00000000-0000-4000-8000-00000000000c'
const USER = '00000000-0000-4000-8000-000000000003'
const HEADERS = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

const DB_TIMEOUT = 30_000

interface QueueItem {
  documentId: string
  title: string
  kind: string
  status: string
  confidence: number | null
  lowestFieldConfidence: number | null
  openErrors: number
  openWarnings: number
  reasons: string[]
  createdAt: string
}

interface QueueBody {
  items: QueueItem[]
  total: number
  limit: number
  nextCursor: string | null
  hasMore: boolean
  error?: string
  param?: string
}

let server: TestServer

async function seedInvoice(
  db: Pool,
  fields: { subtotal?: string; tax?: string; total?: string; currency?: string },
  tenant = TENANT,
  owner = USER,
  customerId: string | null = null,
): Promise<string> {
  const docResult = await db.query<{ id: string }>(
    `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status, customer_id)
     VALUES ($1, $2, 'invoice', 'Review Queue Cursor Test', 'upload', $3, 'Test content', 'text/plain', 'ready', $4)
     RETURNING id`,
    [tenant, owner, `hash-cursor-test-${tenant}-${crypto.randomUUID()}`, customerId],
  )
  const docId = docResult.rows[0]!.id

  const client: PoolClient = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', owner])
    await client.query('SELECT set_config($1, $2, true)', ['app.change_source', 'extraction'])
    await client.query(
      `INSERT INTO invoices (document_id, vendor_name, invoice_number, invoice_date, subtotal, tax, total, currency)
       VALUES ($1, 'Test Vendor', 'INV-1', '2026-01-15', $2, $3, $4, $5)`,
      [docId, fields.subtotal ?? null, fields.tax ?? null, fields.total ?? null, fields.currency ?? null],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return docId
}

async function setStatus(docId: string, status: string) {
  await server.db.query('UPDATE documents SET status = $1 WHERE id = $2', [status, docId])
}

async function addFinding(docId: string, ruleId: string, field: string, severity: 'error' | 'warning') {
  const r = await server.db.query<{ id: string }>(
    `INSERT INTO document_validation
       (document_id, tenant_id, ruleset_version, severity, rule_id, field_name, message)
     VALUES ($1, $2, 'v1', $3, $4, $5, 'seeded by cursor test')
     RETURNING id`,
    [docId, TENANT, severity, ruleId, field],
  )
  return r.rows[0]!.id
}

async function queue(query = '', headers: Record<string, string> = HEADERS): Promise<Response> {
  return server.fetch('/api/documents/review-queue' + query, { headers })
}

async function body(query = '', headers: Record<string, string> = HEADERS) {
  const res = await queue(query, headers)
  return { status: res.status, json: (await res.json()) as QueueBody }
}

async function wipe() {
  await server.db.query('DELETE FROM document_validation WHERE tenant_id = $1', [TENANT])
  await server.db.query('DELETE FROM documents WHERE tenant_id = $1', [TENANT])
}

beforeAll(async () => {
  server = await createTestServer()
}, DB_TIMEOUT)

afterAll(async () => {
  await wipe()
}, DB_TIMEOUT)

describe('GET /review-queue with cursor', () => {
  beforeEach(async () => {
    await wipe()
  }, DB_TIMEOUT)

  it('returns nextCursor and hasMore in response', async () => {
    const res = await queue('?limit=10')
    expect(res.status).toBe(200)
    const json = (await res.json()) as QueueBody
    expect(json).toHaveProperty('nextCursor')
    expect(json).toHaveProperty('hasMore')
    expect(json).not.toHaveProperty('offset')
  }, DB_TIMEOUT)

  it('accepts cursor parameter', async () => {
    // Seed a document so the queue has data
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(doc, 'needs_review')

    const firstRes = await queue('?limit=10')
    const firstBody = (await firstRes.json()) as QueueBody

    // If there's a nextCursor, use it to fetch the next page
    if (firstBody.nextCursor) {
      const secondRes = await queue(`?limit=10&cursor=${firstBody.nextCursor}`)
      expect(secondRes.status).toBe(200)
    }
  }, DB_TIMEOUT)

  it('returns 400 for malformed cursor', async () => {
    const res = await queue('?cursor=invalid')
    expect(res.status).toBe(400)
    const json = (await res.json()) as QueueBody
    expect(json.error).toBe('bad_filter')
    expect(json.param).toBe('cursor')
  }, DB_TIMEOUT)

  it('pages through results using cursor', async () => {
    // Seed 5 documents
    for (let i = 0; i < 5; i++) {
      const doc = await seedInvoice(server.db, { total: String(i) + '.00' })
      await setStatus(doc, 'needs_review')
    }

    // Get first page
    const page1 = await body('?limit=2')
    expect(page1.json.items).toHaveLength(2)
    expect(page1.json.hasMore).toBe(true)
    expect(page1.json.nextCursor).toBeTruthy()

    // Get second page using cursor
    const page2 = await body(`?limit=2&cursor=${page1.json.nextCursor}`)
    expect(page2.json.items).toHaveLength(2)
    expect(page2.json.hasMore).toBe(true)

    // Get third page
    const page3 = await body(`?limit=2&cursor=${page2.json.nextCursor}`)
    expect(page3.json.items).toHaveLength(1)
    expect(page3.json.hasMore).toBe(false)

    // Verify no overlap
    const allIds = [...page1.json.items, ...page2.json.items, ...page3.json.items].map(i => i.documentId)
    expect(new Set(allIds).size).toBe(5)
  }, DB_TIMEOUT)

  it('returns hasMore false when all results fit in one page', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(doc, 'needs_review')

    const { json } = await body('?limit=10')
    expect(json.items).toHaveLength(1)
    expect(json.hasMore).toBe(false)
    expect(json.nextCursor).toBeNull()
  }, DB_TIMEOUT)
})
