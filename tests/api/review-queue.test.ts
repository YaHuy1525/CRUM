import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from '../helpers/test-server.js'
import type { Pool, PoolClient } from 'pg'

// The queue is a tenant-wide read with no owner filter, so membership assertions
// (`total`, ordering, paging) need a tenant nothing else writes into. Tenant
// ...0001 is used by nine database suites, which vitest runs in parallel worker
// processes: clearing it here would delete rows those files seeded in `beforeAll`
// and assert on later. These two uuids belong to this file alone.
const TENANT = '00000000-0000-4000-8000-00000000000b'
const OTHER = '00000000-0000-4000-8000-000000000009'
const USER = '00000000-0000-4000-8000-000000000002'
// Two more members of the same tenant, for the visibility rule of ruling R62: the
// document belongs to OWNER and to OWNER's customer alone, so LOOKER may not see it
// as a `user` and must see it as an `admin`.
const OWNER = '00000000-0000-4000-8000-0000000000d1'
const LOOKER = '00000000-0000-4000-8000-0000000000d2'
const HEADERS = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

// Measured on the baseline run at 28ebfda: seeding one invoice plus one request is
// 2-4s over the remote pooler, and the heaviest case below does that five times.
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
  offset: number
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
     VALUES ($1, $2, 'invoice', 'Review Queue Invoice', 'upload', $3, 'Test content', 'text/plain', 'ready', $4)
     RETURNING id`,
    [tenant, owner, `hash-review-queue-${tenant}-${crypto.randomUUID()}`, customerId],
  )
  const docId = docResult.rows[0]!.id

  const client: PoolClient = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', owner])
    await client.query('SELECT set_config($1, $2, true)', ['app.change_source', 'extraction'])
    // invoice_number and invoice_date are fixed and valid on purpose: the presence
    // rules for those two columns would otherwise put an open error on a document
    // this suite seeded only to exist.
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

async function seedCustomer(name: string, ownerId: string): Promise<string> {
  const r = await server.db.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, name, owner_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [TENANT, name, ownerId],
  )
  return r.rows[0]!.id
}

async function setStatus(docId: string, status: string) {
  await server.db.query('UPDATE documents SET status = $1 WHERE id = $2', [status, docId])
}

async function setConfidence(docId: string, map: Record<string, number>) {
  await server.db.query('UPDATE documents SET field_confidence = $2::jsonb WHERE id = $1', [docId, JSON.stringify(map)])
}

async function setCreated(docId: string, at: string) {
  await server.db.query('UPDATE documents SET created_at = $2::timestamptz WHERE id = $1', [docId, at])
}

async function addFinding(docId: string, ruleId: string, field: string, severity: 'error' | 'warning') {
  const r = await server.db.query<{ id: string }>(
    `INSERT INTO document_validation
       (document_id, tenant_id, ruleset_version, severity, rule_id, field_name, message)
     VALUES ($1, $2, 'v1', $3, $4, $5, 'seeded by review-queue test')
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

function asUser(userId: string, role: 'user' | 'admin') {
  return { 'x-tenant-id': TENANT, 'x-user-id': userId, 'x-user-role': role }
}

function idsOf(json: QueueBody): string[] {
  return json.items.map((i) => i.documentId)
}

async function wipe() {
  await server.db.query('DELETE FROM document_validation WHERE tenant_id = ANY($1::uuid[])', [[TENANT, OTHER]])
  await server.db.query('DELETE FROM documents WHERE tenant_id = ANY($1::uuid[])', [[TENANT, OTHER]])
  await server.db.query('DELETE FROM customers WHERE tenant_id = ANY($1::uuid[])', [[TENANT, OTHER]])
}

beforeAll(async () => {
  server = await createTestServer()
}, DB_TIMEOUT)

afterAll(async () => {
  await wipe()
}, DB_TIMEOUT)

describe('GET /review-queue auth and filters', () => {
  it('refuses a request with no identity headers', async () => {
    expect((await server.fetch('/api/documents/review-queue')).status).toBe(401)
  }, DB_TIMEOUT)

  it('400s an unknown kind', async () => {
    expect((await body('?kind=receipt')).json.error).toBe('bad_filter')
  }, DB_TIMEOUT)

  it('400s an unknown severity', async () => {
    expect((await body('?severity=critical')).json.error).toBe('bad_filter')
  }, DB_TIMEOUT)

  it('400s a non-numeric limit', async () => {
    const res = await body('?limit=abc')
    expect(res.json.error).toBe('bad_filter')
    expect(res.status).toBe(400)
  }, DB_TIMEOUT)
})

describe('GET /review-queue membership', () => {
  beforeEach(async () => {
    await wipe()
  }, DB_TIMEOUT)

  it('routes /review-queue to the queue, not to the :id handler', async () => {
    const res = await queue()
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveProperty('items')
  }, DB_TIMEOUT)

  it('queues a needs_review document with no findings', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(doc, 'needs_review')
    const { json } = await body()
    expect(json.total).toBe(1)
    expect(json.items[0]!.reasons).toEqual(['needs review'])
  }, DB_TIMEOUT)

  it('queues a ready document that carries one open finding', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(doc, 'ready')
    await addFinding(doc, 'invoice.total.sum', 'total', 'error')
    const { json } = await body()
    expect(json.items).toHaveLength(1)
    expect(json.items[0]!.openErrors).toBe(1)
    expect(json.items[0]!.reasons).toEqual(['open error'])
  }, DB_TIMEOUT)

  it('does not queue a ready document whose only finding is waived', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(doc, 'ready')
    await addFinding(doc, 'invoice.total.sum', 'total', 'error')
    await server.db.query("UPDATE document_validation SET status = 'waived' WHERE document_id = $1", [doc])
    expect((await body()).json.total).toBe(0)
  }, DB_TIMEOUT)

  it('never shows another tenant document', async () => {
    const mine = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(mine, 'needs_review')
    // Seeded straight into the other tenant, so the assertion below is about the
    // predicate and not about an empty table.
    const theirs = await seedInvoice(server.db, { total: '20.00' }, OTHER)
    await server.db.query('UPDATE documents SET status = $2 WHERE id = $1', [theirs, 'needs_review'])
    await server.db.query(
      `INSERT INTO document_validation
         (document_id, tenant_id, ruleset_version, severity, rule_id, field_name, message)
       VALUES ($1, $2, 'v1', 'error', 'invoice.total.sum', 'total', 'other tenant finding')`,
      [theirs, OTHER],
    )

    const { json } = await body()
    expect(json.total).toBe(1)
    expect(idsOf(json)).toEqual([mine])
  }, DB_TIMEOUT)

  it('excludes a document of kind other', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await server.db.query("UPDATE documents SET kind = 'other', status = 'needs_review' WHERE id = $1", [doc])
    expect((await body()).json.total).toBe(0)
  }, DB_TIMEOUT)
})

describe('GET /review-queue visibility', () => {
  beforeEach(async () => {
    await wipe()
  }, DB_TIMEOUT)

  it('does not show a user the unshared-customer document of another member', async () => {
    const customer = await seedCustomer('Queue Visibility Customer', OWNER)
    const doc = await seedInvoice(server.db, { total: '10.00' }, TENANT, OWNER, customer)
    await setStatus(doc, 'needs_review')

    // The owner's own page is the control: the empty one below is the rule, not an
    // empty table.
    expect(idsOf((await body('', asUser(OWNER, 'user'))).json)).toEqual([doc])
    expect(idsOf((await body('', asUser(LOOKER, 'user'))).json)).toEqual([])
  }, DB_TIMEOUT)

  it('shows that same document to an admin in the tenant', async () => {
    const customer = await seedCustomer('Queue Visibility Admin Customer', OWNER)
    const doc = await seedInvoice(server.db, { total: '10.00' }, TENANT, OWNER, customer)
    await setStatus(doc, 'needs_review')

    expect(idsOf((await body('', asUser(LOOKER, 'admin'))).json)).toEqual([doc])
  }, DB_TIMEOUT)
})

describe('GET /review-queue ordering', () => {
  beforeEach(async () => {
    await wipe()
  }, DB_TIMEOUT)

  it('puts more open errors first', async () => {
    const two = await seedInvoice(server.db, { total: '10.00' })
    const one = await seedInvoice(server.db, { total: '20.00' })
    await setStatus(two, 'ready')
    await setStatus(one, 'ready')
    await addFinding(two, 'invoice.total.sum', 'total', 'error')
    await addFinding(two, 'invoice.vendor_name.present', 'vendor_name', 'error')
    await addFinding(one, 'invoice.total.sum', 'total', 'error')
    expect(idsOf((await body()).json)).toEqual([two, one])
  }, DB_TIMEOUT)

  it('prefers an error document over a warning-only document regardless of confidence', async () => {
    const warnLow = await seedInvoice(server.db, { total: '10.00' })
    const errHigh = await seedInvoice(server.db, { total: '20.00' })
    await setStatus(warnLow, 'ready')
    await setStatus(errHigh, 'ready')
    await addFinding(warnLow, 'invoice.currency.shape', 'currency', 'warning')
    await addFinding(errHigh, 'invoice.total.sum', 'total', 'error')
    await setConfidence(warnLow, { vendorName: 0.05 })
    await setConfidence(errHigh, { vendorName: 0.99 })
    expect((await body()).json.items[0]!.documentId).toBe(errHigh)
  }, DB_TIMEOUT)

  it('sorts equal error counts by lowest field confidence, nulls last', async () => {
    const noMap = await seedInvoice(server.db, { total: '10.00' })
    const low = await seedInvoice(server.db, { total: '20.00' })
    const high = await seedInvoice(server.db, { total: '30.00' })
    for (const d of [noMap, low, high]) await setStatus(d, 'ready')
    for (const d of [noMap, low, high]) await addFinding(d, 'invoice.total.sum', 'total', 'error')
    await setConfidence(low, { vendorName: 0.1, total: 0.4 })
    await setConfidence(high, { vendorName: 0.95 })
    const { json } = await body()
    expect(idsOf(json)).toEqual([low, high, noMap])
    expect(json.items[0]!.lowestFieldConfidence).toBe(0.1)
    expect(json.items[2]!.lowestFieldConfidence).toBeNull()
  }, DB_TIMEOUT)

  it('sorts oldest first inside a tier', async () => {
    const older = await seedInvoice(server.db, { total: '10.00' })
    const newer = await seedInvoice(server.db, { total: '20.00' })
    await setStatus(older, 'needs_review')
    await setStatus(newer, 'needs_review')
    await setCreated(older, '2026-08-01T00:00:00Z')
    expect(idsOf((await body()).json)).toEqual([older, newer])
  }, DB_TIMEOUT)

  it('reports low confidence in reasons only below the intake threshold', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(doc, 'needs_review')
    await setConfidence(doc, { vendorName: 0.699 })
    expect((await body()).json.items[0]!.reasons).toContain('low confidence')
    await setConfidence(doc, { vendorName: 0.7 })
    expect((await body()).json.items[0]!.reasons).not.toContain('low confidence')
  }, DB_TIMEOUT)
})

describe('GET /review-queue paging', () => {
  beforeEach(async () => {
    await wipe()
  }, DB_TIMEOUT)

  it('defaults to 50 and clamps a request above 200', async () => {
    expect((await body()).json.limit).toBe(50)
    expect((await body('?limit=500')).json.limit).toBe(200)
    expect((await body('?limit=0')).json.error).toBe('bad_filter')
  }, DB_TIMEOUT)

  it('pages without dropping items', async () => {
    for (let i = 0; i < 5; i++) {
      const doc = await seedInvoice(server.db, { total: String(i) + '.00' })
      await setStatus(doc, 'needs_review')
    }
    const all = await body()
    const page1 = await body('?limit=2&offset=0')
    const page2 = await body('?limit=2&offset=2')
    const page3 = await body('?limit=2&offset=4')
    expect(all.json.total).toBe(5)
    expect(page1.json.total).toBe(5)
    const seen = [...page1.json.items, ...page2.json.items, ...page3.json.items].map((i) => i.documentId)
    expect(new Set(seen).size).toBe(5)
  }, DB_TIMEOUT)

  it('filters by severity and by kind', async () => {
    const inv = await seedInvoice(server.db, { total: '10.00' })
    await addFinding(inv, 'invoice.total.sum', 'total', 'warning')
    const con = await seedInvoice(server.db, { total: '20.00' })
    await server.db.query("UPDATE documents SET kind = 'contract' WHERE id = $1", [con])
    await addFinding(con, 'contract.value.present', 'contract_value', 'error')
    expect((await body('?severity=error')).json.total).toBe(1)
    expect((await body('?severity=warning')).json.total).toBe(1)
    expect((await body('?kind=contract')).json.total).toBe(1)
    expect((await body('?kind=contract&severity=warning')).json.total).toBe(0)
  }, DB_TIMEOUT)
})
