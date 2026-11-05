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

async function seedCustomer(
  name: string,
  ownerId: string,
  teamMemberIds: string[] = [],
): Promise<string> {
  const r = await server.db.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, name, owner_id, team_member_ids)
     VALUES ($1, $2, $3, $4::uuid[])
     RETURNING id`,
    [TENANT, name, ownerId, teamMemberIds],
  )
  return r.rows[0]!.id
}

// `setConfidence` takes numbers only, which is exactly why a jsonb `null` inside a
// field map needs its own raw writer: the queue's NULLIF guard would otherwise be
// unreachable from this file, and deleting it would leave the suite green.
async function setRawConfidence(docId: string, map: unknown) {
  await server.db.query('UPDATE documents SET field_confidence = $2::jsonb WHERE id = $1', [
    docId, JSON.stringify(map),
  ])
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
  // Ruling R72: this was the only describe in the file without the wipe, and its ISO
  // case below is the only case in it that seeds. Harmless today because that case finds
  // its row with `.find()`, and a false pass the first time anyone asserts a `total`
  // here, because whatever a previous file left in this tenant would be counted.
  beforeEach(async () => {
    await wipe()
  }, DB_TIMEOUT)

  it('refuses a request with no identity headers', async () => {
    expect((await server.fetch('/api/documents/review-queue')).status).toBe(401)
  }, DB_TIMEOUT)

  it('400s an unknown kind', async () => {
    const res = await body('?kind=receipt')
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('bad_filter')
    expect(res.json.param).toBe('kind')
  }, DB_TIMEOUT)

  it('400s an unknown severity', async () => {
    const res = await body('?severity=critical')
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('bad_filter')
    expect(res.json.param).toBe('severity')
  }, DB_TIMEOUT)

  it('400s a non-numeric limit', async () => {
    const res = await body('?limit=abc')
    expect(res.json.error).toBe('bad_filter')
    expect(res.status).toBe(400)
  }, DB_TIMEOUT)

  // Ruling R69, ride-along 4: replaced offset range check with cursor format validation.
  // A malformed cursor is rejected with 400 before it reaches the database layer.
  it('400s a malformed cursor instead of faulting the query', async () => {
    const res = await body('?cursor=invalid')
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('bad_filter')
    expect(res.json.param).toBe('cursor')
  }, DB_TIMEOUT)

  // Ruling R69, gate 1: the queue used to project `d.created_at::text`, which emits
  // DateStyle text (`2026-11-04 10:04:01.133009+00`) and is only right while the
  // session holds `ISO, MDY`. Every other timestamp route ships ISO-8601.
  it('sends createdAt as an ISO-8601 instant, not DateStyle text', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(doc, 'needs_review')
    await setCreated(doc, '2026-08-01T12:34:56.789Z')

    const { json } = await body()
    const mine = json.items.find((i) => i.documentId === doc)
    expect(mine).toBeDefined()
    const createdAt = mine!.createdAt
    expect(createdAt).toBe('2026-08-01T12:34:56.789Z')
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(createdAt).not.toContain(' ')
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

  // Ruling R69, ride-along 5: `NULLIF(kv.value, 'null'::jsonb)` inside the page's
  // scalar subquery is the only thing standing between one null in a field map and a
  // `cannot cast jsonb null to type numeric` that 500s the entire queue for the tenant.
  it('serves a queue whose member holds a jsonb null in its field map', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(doc, 'needs_review')
    await setRawConfidence(doc, { vendorName: null })

    const res = await queue()
    expect(res.status).toBe(200)
    const json = (await res.json()) as QueueBody
    const mine = json.items.find((i) => i.documentId === doc)
    expect(mine).toBeDefined()
    expect(mine!.lowestFieldConfidence).toBeNull()
  }, DB_TIMEOUT)

  // A null next to real numbers must not become the lowest, and must not poison the
  // MIN() either: the guard drops the null and the numbers still rank.
  it('reads lowest field confidence through a mixed null and number field map', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(doc, 'ready')
    await addFinding(doc, 'invoice.total.sum', 'total', 'error')
    await setRawConfidence(doc, { vendorName: null, total: 0.42 })

    const { json } = await body()
    expect(json.items.find((i) => i.documentId === doc)!.lowestFieldConfidence).toBe(0.42)
  }, DB_TIMEOUT)
})

// Ruling R69, ride-along 6: severity is an attribute of findings, not of queue
// membership. The two cases below pin what the plan and spec leave silent: a
// status-only queue member vanishes under any severity filter, and one whose only open
// finding is of the other severity vanishes under the filter it does not match. Both
// are decided as correct, because `total` and the chips stay honest. Not a bug report:
// if this changes, R69 is being reopened.
describe('GET /review-queue severity filter reads findings (ruling R69)', () => {
  beforeEach(async () => {
    await wipe()
  }, DB_TIMEOUT)

  it('hides a warning-only needs_review document from severity=error', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(doc, 'needs_review')
    await addFinding(doc, 'invoice.currency.shape', 'currency', 'warning')

    const all = await body()
    expect(all.json.total).toBe(1)
    expect(idsOf(all.json)).toEqual([doc])
    expect(all.json.items[0]!.reasons).toContain('needs review')

    const errors = await body('?severity=error')
    expect(errors.json.total).toBe(0)
    expect(errors.json.items).toEqual([])

    expect((await body('?severity=warning')).json.total).toBe(1)
  }, DB_TIMEOUT)

  it('hides a needs_review document with no findings from any severity filter', async () => {
    const doc = await seedInvoice(server.db, { total: '10.00' })
    await setStatus(doc, 'needs_review')

    expect((await body()).json.total).toBe(1)
    expect((await body('?severity=error')).json.total).toBe(0)
    expect((await body('?severity=warning')).json.total).toBe(0)
    // The chip that names the reason it is queued cannot survive the filter, which is
    // the whole decision: the document is still there unfiltered.
    expect(idsOf((await body('?kind=invoice')).json)).toEqual([doc])
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

    const { json } = await body('', asUser(LOOKER, 'admin'))
    expect(idsOf(json)).toEqual([doc])
    expect(json.total).toBe(1)
    expect(json.items).toHaveLength(1)
  }, DB_TIMEOUT)

  // Ruling R69, ride-along 7c: the two arms of the `user` half of `docVisibility`
  // (src/db/visibility.ts:25-30) are what this rule is actually for, and neither was
  // pinned. Collapsing the branch to `tenant_id AND owner_id` — which silently revokes
  // shared and customer-less documents from listDocuments, getDocument, sumInvoices and
  // reviewDocument — passed this file. Both documents below belong to OWNER, so the only
  // way LOOKER can read them is the arm each case names.
  it('shows a user the team-shared and customer-less documents of another member', async () => {
    const shared = await seedCustomer('Queue Team Shared Customer', OWNER, [LOOKER])
    const sharedDoc = await seedInvoice(server.db, { total: '10.00' }, TENANT, OWNER, shared)
    const loneDoc = await seedInvoice(server.db, { total: '20.00' }, TENANT, OWNER, null)
    for (const d of [sharedDoc, loneDoc]) await setStatus(d, 'needs_review')

    const asOwner = (await body('', asUser(OWNER, 'user'))).json
    expect(idsOf(asOwner).sort()).toEqual([sharedDoc, loneDoc].sort())
    expect(asOwner.total).toBe(2)

    const { json } = await body('', asUser(LOOKER, 'user'))
    expect(json.total).toBe(2)
    expect(idsOf(json).sort()).toEqual([sharedDoc, loneDoc].sort())
  }, DB_TIMEOUT)

  // Ruling R69, ride-along 7d: the admin COUNT is bound from `params.slice(0, firstFilter + 1)`
  // (src/db/validation.ts) precisely because an admin has one visibility parameter and a
  // user has two. No admin case applied a filter, so that slice had no cover on the branch
  // it was written for. Here the filtered totals and the filtered pages have to agree.
  it('agrees between the filtered admin COUNT and the filtered admin page', async () => {
    const inv = await seedInvoice(server.db, { total: '10.00' }, TENANT, OWNER, null)
    const con = await seedInvoice(server.db, { total: '20.00' }, TENANT, OWNER, null)
    for (const d of [inv, con]) await setStatus(d, 'ready')
    await addFinding(inv, 'invoice.total.sum', 'total', 'error')
    await server.db.query("UPDATE documents SET kind = 'contract' WHERE id = $1", [con])
    await addFinding(con, 'contract.value.present', 'contract_value', 'error')

    const admin = asUser(LOOKER, 'admin')
    for (const [query, expected] of [
      ['?kind=contract', [con]],
      ['?kind=invoice', [inv]],
      ['?kind=contract&severity=error', [con]],
      ['?kind=contract&severity=warning', []],
    ] as [string, string[]][]) {
      const { json } = await body(query, admin)
      expect(idsOf(json).sort()).toEqual([...expected].sort())
      expect(json.total).toBe(expected.length)
      expect(json.items).toHaveLength(expected.length)
    }

    const userSide = await body('?kind=contract', asUser(OWNER, 'user'))
    expect(userSide.json.total).toBe(1)
    expect(idsOf(userSide.json)).toEqual([con])

    // Ruling R72: "the COUNT agrees with the page" is not "the COUNT is independent of
    // the page". Every query in the loop above has a total of 0 or 1 and runs at the
    // default limit of 50, so `rows.length === total` on all four of them and an
    // implementation that reported `total: rows.length` would pass this case untouched.
    // Two documents carry an open error here, so ask for one row and require the count
    // to still say two.
    const paged = await body('?severity=error&limit=1', admin)
    expect(paged.json.total).toBe(2)
    expect(paged.json.items).toHaveLength(1)
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
    const page1 = await body('?limit=2')
    expect(page1.json.hasMore).toBe(true)
    const page2 = await body(`?limit=2&cursor=${page1.json.nextCursor}`)
    expect(page2.json.hasMore).toBe(true)
    const page3 = await body(`?limit=2&cursor=${page2.json.nextCursor}`)
    expect(all.json.total).toBe(5)
    expect(page1.json.total).toBe(5)
    // Ride-along 7b: a page's shape has to be a page. Without these three lines an
    // implementation that ignored `limit` and `cursor` and returned all five rows on
    // every call still passed the assertions below.
    expect(page1.json.items).toHaveLength(2)
    expect(page2.json.items).toHaveLength(2)
    expect(page3.json.items).toHaveLength(1)
    const seen = [...page1.json.items, ...page2.json.items, ...page3.json.items].map((i) => i.documentId)
    expect(new Set(seen).size).toBe(5)
  }, DB_TIMEOUT)

  // Ride-along 3, widened by ruling R72: `d.created_at ASC` is not a total order. Five
  // separate autocommit INSERTs always get distinct transaction `now()` values, so the
  // only way to build a tie is to write all three keys the ORDER BY reads before `d.id`
  // by hand. Three tied rows made this a probabilistic detector: a mutant whose arbitrary
  // tiebreak happens to be id ascending coincides with the expected order 1 time in 6.
  // Six rows make that 1 in 720, and the second identical pass catches an ORDER BY that
  // is unstable between requests yet looks whole inside a single pass.
  it('pages a six-way tie without overlap or loss', async () => {
    const docs: string[] = []
    for (let i = 0; i < 6; i++) {
      const doc = await seedInvoice(server.db, { total: '10.00' })
      await setStatus(doc, 'ready')
      await addFinding(doc, 'invoice.total.sum', 'total', 'error')
      await setConfidence(doc, { vendorName: 0.5 })
      await setCreated(doc, '2026-09-01T00:00:00Z')
      docs.push(doc)
    }
    const expected = [...docs].sort()

    const all = await body()
    expect(all.json.total).toBe(6)
    expect(idsOf(all.json)).toEqual(expected)

    // Measured at 12.8s for the whole case (six seeds, one full page, two passes of three
    // pages) against the pooler, which is inside the file's single DB_TIMEOUT allowance.
    const passes: string[][] = []
    for (let pass = 0; pass < 2; pass++) {
      const seen: string[] = []
      let cursor: string | null | undefined = undefined
      for (let page = 0; page < 3; page++) {
        const query = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2'
        const result = await body(query)
        expect(result.json.total).toBe(6)
        expect(result.json.items).toHaveLength(2)
        seen.push(...idsOf(result.json))
        cursor = result.json.nextCursor
      }
      expect(seen).toEqual(expected)
      expect(new Set(seen).size).toBe(6)
      passes.push(seen)
    }
    expect(passes[0]).toEqual(passes[1])
  }, DB_TIMEOUT)

  // Ruling R72: the `user` half of `docVisibility` (src/db/visibility.ts:25-30) binds two
  // parameters, so on that branch every later placeholder is numbered from 3 — and neither
  // the severity `EXISTS` nor `limit`/`cursor` had ever been sent there. The existing
  // `?kind=contract`-as-`user` request pins `$2`-derived numbering for the kind filter
  // alone; hard-coding or swapping the severity and paging placeholders was free. One
  // request carrying all three makes each of them a wrong page rather than a coincidence.
  it('binds severity, limit and cursor on the two-parameter user branch', async () => {
    // Both documents hang off one customer owned by OWNER and shared with nobody, so the
    // actor parameter is what decides visibility here: a customer-less document would be
    // readable by every member of the tenant (the R69 arm pinned above) and the empty page
    // below would prove nothing.
    const customer = await seedCustomer('Queue Paging Customer', OWNER)
    const older = await seedInvoice(server.db, { total: '10.00' }, TENANT, OWNER, customer)
    const newer = await seedInvoice(server.db, { total: '20.00' }, TENANT, OWNER, customer)
    for (const d of [older, newer]) {
      await setStatus(d, 'ready')
      await addFinding(d, 'invoice.total.sum', 'total', 'error')
    }
    await setCreated(older, '2026-08-01T00:00:00Z')
    await setCreated(newer, '2026-08-02T00:00:00Z')

    // Equal error counts and no field maps, so the tier's remaining key is created_at and
    // cursor pagination names a specific row rather than whichever row the database felt like.
    const first = await body('?severity=error&limit=1', asUser(OWNER, 'user'))
    expect(first.json.total).toBe(2)
    expect(first.json.items).toHaveLength(1)
    expect(idsOf(first.json)).toEqual([older])
    expect(first.json.nextCursor).toBeTruthy()

    const second = await body(`?severity=error&limit=1&cursor=${first.json.nextCursor}`, asUser(OWNER, 'user'))
    expect(second.json.total).toBe(2)
    expect(second.json.items).toHaveLength(1)
    expect(idsOf(second.json)).toEqual([newer])

    // The same request as a member who owns neither document and shares no customer with
    // OWNER: the paging arms must not be able to widen what visibility removed.
    const empty = await body('?severity=error&limit=1', asUser(LOOKER, 'user'))
    expect(empty.json.total).toBe(0)
    expect(empty.json.items).toEqual([])
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
