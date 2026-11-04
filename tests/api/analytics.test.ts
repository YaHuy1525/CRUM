import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from '../helpers/test-server.js'
import type { Pool, PoolClient } from 'pg'

// Ruling R71: this file owns its tenant pair. Vitest runs test files in parallel worker
// processes, and every metric case here starts with a `wipe()` scoped by `tenant_id`, so
// sharing a tenant with another suite turns that DELETE into a cross-file deletion of
// rows the other file is asserting on. `...000b`/`...0009` belong to
// tests/api/review-queue.test.ts and `...0001` is seeded by nine database suites in their
// own `beforeAll`; these two uuids were measured unclaimed across tests/, src/ and the
// plan. A fresh uuid needs no `tenants` row and no migration, because
// `documents.tenant_id` carries no foreign key (migrations/0009_crum_documents.sql:26).
const TENANT = 'a8000000-0000-4000-8000-000000000012'
const OTHER = 'a8000000-0000-4000-8000-000000000112'
const USER = '00000000-0000-4000-8000-000000000002'
// `x-user-role` is a required claim (ruling R52): without it the request 401s before the
// route body runs, and nothing below would be testing the SQL.
const HEADERS: Record<string, string> = {
  'x-tenant-id': TENANT,
  'x-user-id': USER,
  'x-user-role': 'admin',
}

// Same allowance the sibling database suites use: each round trip crosses the remote
// pooler and the heaviest case below seeds five documents.
const DB_TIMEOUT = 30_000

interface AnalyticsBody {
  window: { from: string; to: string; days: number }
  byRule: Array<{ ruleId: string; total: number; open: number; waived: number }>
  topFields: Array<{ field: string; corrections: number; violations: number }>
  bySource: Array<{ changeSource: string; count: number }>
  correctionRate: { corrected: number; documents: number; rate: number | null }
  turnaround: { p50Hours: number | null; p90Hours: number | null }
  confidenceTrend: Array<{ week: string; avgConfidence: number | null; correctionRate: number | null }>
  error?: string
  maxDays?: number
}

let server: TestServer

// Widened on purpose (ruling R53): every amount is optional and goes in as written, never
// defaulted. A defaulted `subtotal` would fire `invoice.total.sum` on a row this suite only
// wanted to exist, and the sixteen call sites below pass one field at a time.
async function seedInvoice(
  db: Pool,
  fields: { subtotal?: string; tax?: string; total?: string; currency?: string },
  tenant = TENANT,
): Promise<string> {
  const docResult = await db.query<{ id: string }>(
    `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status)
     VALUES ($1, $2, 'invoice', 'Analytics Invoice', 'upload', $3, 'Test content', 'text/plain', 'ready')
     RETURNING id`,
    [tenant, USER, `hash-analytics-${tenant}-${crypto.randomUUID()}`],
  )
  const docId = docResult.rows[0]!.id

  const client: PoolClient = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', USER])
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

async function addFinding(docId: string, ruleId: string, field: string, severity: 'error' | 'warning') {
  const r = await server.db.query<{ id: string }>(
    `INSERT INTO document_validation
       (document_id, tenant_id, ruleset_version, severity, rule_id, field_name, message)
     VALUES ($1, $2, 'v1', $3, $4, $5, 'seeded by analytics test')
     RETURNING id`,
    [docId, TENANT, severity, ruleId, field],
  )
  return r.rows[0]!.id
}

// A direct INSERT, not the correction route: this case is about which rows an aggregate
// counts, and the trigger would put every column of the invoice on the trail at now().
async function addAudit(docId: string, field: string, source: string, at: string, by = USER) {
  await server.db.query(
    `INSERT INTO document_field_audit
       (document_id, tenant_id, table_name, field_name, action, new_value, changed_by, changed_at, change_source)
     VALUES ($1, $2, 'invoices', $3, 'update', $4::jsonb, $5, $6::timestamptz, $7)`,
    [docId, TENANT, field, JSON.stringify('x'), by, at, source],
  )
}

async function setCreated(docId: string, at: string) {
  await server.db.query('UPDATE documents SET created_at = $2::timestamptz WHERE id = $1', [docId, at])
}

function hoursAfter(hours: number): string {
  return new Date(Date.UTC(2026, 8, 20, hours)).toISOString()
}

// Child-first (ruling R71's shape note, item 5): `document_field_audit` and
// `document_validation` both hang off `documents`.
async function wipe() {
  await server.db.query('DELETE FROM document_field_audit WHERE tenant_id = $1', [TENANT])
  await server.db.query('DELETE FROM document_validation WHERE tenant_id = $1', [TENANT])
  await server.db.query('DELETE FROM documents WHERE tenant_id = $1', [TENANT])
}

async function analytics(query = '') {
  const res = await server.fetch('/api/documents/analytics/review' + query, { headers: HEADERS })
  return { status: res.status, json: (await res.json()) as AnalyticsBody }
}

beforeAll(async () => {
  server = await createTestServer()
}, DB_TIMEOUT)

afterAll(async () => {
  await wipe()
}, DB_TIMEOUT)

describe('GET /analytics/review window handling', () => {
  it('refuses a malformed from', async () => {
    const res = await analytics('?from=31-12-2026')
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('bad_range')
  }, DB_TIMEOUT)

  it('refuses from after to', async () => {
    const res = await analytics('?from=2026-06-01&to=2026-05-01')
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('bad_range')
  }, DB_TIMEOUT)

  it('refuses a window longer than 365 days', async () => {
    const res = await analytics('?from=2025-01-01&to=2026-12-31')
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('bad_range')
  }, DB_TIMEOUT)

  it('defaults to the last 90 days and labels the window it used', async () => {
    const { json } = await analytics()
    expect(json.window.days).toBe(90)
    expect(String(json.window.to)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  }, DB_TIMEOUT)

  it('400s a kind that is neither invoice nor contract', async () => {
    const res = await analytics('?kind=receipt')
    expect(res.status).toBe(400)
    expect(res.json.error).toBe('bad_filter')
  }, DB_TIMEOUT)

  // Ruling R59, and the reason this case exists: the label must name the operator's own
  // calendar day. The local midnight of 2026-11-03 on this box (UTC+11) is
  // 2026-11-02T13:00Z, so a `toISOString().slice(0, 10)` of that edge prints the day
  // before the one the request asked for, on both labels, every request. The last two
  // lines read the local today without the route's own renderer, so they compare the label
  // to the day it claims instead of comparing a helper to itself.
  it('labels the window with the local day the operator named', async () => {
    const named = (await analytics('?from=2026-11-03&to=2026-11-03')).json
    expect(named.window.from).toBe('2026-11-03')
    expect(named.window.to).toBe('2026-11-03')
    expect(named.window.days).toBe(1)

    const localToday = new Date().toLocaleDateString('en-CA')
    const { json } = await analytics()
    expect(json.window.to).toBe(localToday)
  }, DB_TIMEOUT)
})

describe('GET /analytics/review metrics', () => {
  beforeEach(async () => {
    await wipe()
  }, DB_TIMEOUT)

  it('returns every key empty and a null rate when there is no data', async () => {
    const { json } = await analytics()
    expect(json.byRule).toEqual([])
    expect(json.topFields).toEqual([])
    expect(json.bySource).toEqual([])
    expect(json.confidenceTrend).toEqual([])
    expect(json.correctionRate).toEqual({ corrected: 0, documents: 0, rate: null })
    expect(json.turnaround).toEqual({ p50Hours: null, p90Hours: null })
  }, DB_TIMEOUT)

  it('groups findings by rule with open and waived split', async () => {
    const a = await seedInvoice(server.db, { total: '10.00' })
    const b = await seedInvoice(server.db, { total: '20.00' })
    const id1 = await addFinding(a, 'invoice.total.sum', 'total', 'error')
    await addFinding(b, 'invoice.total.sum', 'total', 'error')
    await addFinding(a, 'invoice.currency.shape', 'currency', 'warning')
    await server.db.query("UPDATE document_validation SET status='waived' WHERE id = $1", [id1])
    const { json } = await analytics()
    const sum = json.byRule.find((r) => r.ruleId === 'invoice.total.sum')
    expect(sum).toEqual({ ruleId: 'invoice.total.sum', total: 2, open: 1, waived: 1 })
    expect(json.byRule[0]!.total).toBeGreaterThanOrEqual(json.byRule[json.byRule.length - 1]!.total)
  }, DB_TIMEOUT)

  it('excludes a finding created outside the window', async () => {
    const a = await seedInvoice(server.db, { total: '10.00' })
    await addFinding(a, 'invoice.total.sum', 'total', 'error')
    // Scoped to this tenant: the shared pooler holds other tenants' rows, and a bare
    // UPDATE here would rewrite them.
    await server.db.query(
      "UPDATE document_validation SET created_at = '2020-01-01T00:00:00Z'::timestamptz WHERE tenant_id = $1",
      [TENANT],
    )
    expect((await analytics()).json.byRule).toEqual([])
  }, DB_TIMEOUT)

  it('ranks topFields by corrections and pairs the violation count', async () => {
    const a = await seedInvoice(server.db, { total: '10.00' })
    await addAudit(a, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    await addAudit(a, 'total', 'manual_correction', '2026-10-02T00:00:00Z')
    await addAudit(a, 'vendor_name', 'manual_correction', '2026-10-02T00:00:00Z')
    await addAudit(a, 'currency', 'extraction', '2026-10-02T00:00:00Z')
    await addFinding(a, 'invoice.total.sum', 'total', 'error')
    const { json } = await analytics()
    expect(json.topFields).toEqual([
      { field: 'total', corrections: 2, violations: 1 },
      { field: 'vendor_name', corrections: 1, violations: 0 },
    ])
  }, DB_TIMEOUT)

  // The window is pinned to 2026-10-01..02 rather than left at the default because the
  // intake trigger writes one `insert`/`extraction` audit row per non-null invoice column
  // at `now()`, and the default 90 days would count those alongside the rows below. The
  // assertion is about which sources land in which bucket and in what order, and a window
  // that excludes the seeding instant says that exactly.
  it('counts audit rows by change source', async () => {
    const a = await seedInvoice(server.db, { total: '10.00' })
    await addAudit(a, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    await addAudit(a, 'tax', 'manual_correction', '2026-10-01T00:00:00Z')
    await addAudit(a, 'vendor_name', 'extraction', '2026-10-02T00:00:00Z')
    const { json } = await analytics('?from=2026-10-01&to=2026-10-02')
    expect(json.bySource).toEqual([
      { changeSource: 'manual_correction', count: 2 },
      { changeSource: 'extraction', count: 1 },
    ])
  }, DB_TIMEOUT)

  // Ruling R54: both edges are the operator's local midnights. 09:00 here is 22:00 the day
  // before in UTC, so a window built from UTC midnights and named "2026-11-03" would drop
  // this row even though the operator means the whole of their own 3 November.
  it('counts a correction on the local morning of the day the window names', async () => {
    const a = await seedInvoice(server.db, { total: '10.00' })
    await addAudit(a, 'total', 'manual_correction', new Date(2026, 10, 3, 9, 0, 0).toISOString())
    const { json } = await analytics('?from=2026-11-03&to=2026-11-03')
    expect(json.bySource).toEqual([{ changeSource: 'manual_correction', count: 1 }])
  }, DB_TIMEOUT)

  it('computes correctionRate as corrected documents over documents created in the window', async () => {
    const a = await seedInvoice(server.db, { total: '10.00' })
    const b = await seedInvoice(server.db, { total: '20.00' })
    await seedInvoice(server.db, { total: '30.00' })
    await addAudit(a, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    await addAudit(a, 'tax', 'manual_correction', '2026-10-02T00:00:00Z')
    await addAudit(b, 'total', 'manual_correction', '2026-10-02T00:00:00Z')
    const { json } = await analytics()
    // Ruling R14: numerator = corrections in the window on documents of any age,
    // denominator = documents created in the window. The two integers travel with the
    // rate because their quotient is not a fraction of the same population.
    expect(json.correctionRate).toEqual({ corrected: 2, documents: 3, rate: 2 / 3 })
  }, DB_TIMEOUT)

  it('reports turnaround as the median and p90 of creation to first correction, in hours', async () => {
    const hours = [1, 2, 3, 4, 10]
    for (const h of hours) {
      const d = await seedInvoice(server.db, { total: '10.00' })
      await setCreated(d, '2026-09-20T00:00:00Z')
      await addAudit(d, 'total', 'manual_correction', hoursAfter(h))
    }
    const { json } = await analytics('?from=2026-09-01&to=2026-09-30')
    // Ruling R13: measured from documents.created_at, so queue wait is inside this
    // number, which is why the panel calls it "created to first correction".
    expect(json.turnaround.p50Hours).toBeCloseTo(3, 6)
    expect(json.turnaround.p90Hours).toBeCloseTo(7.6, 6)
  }, DB_TIMEOUT)

  it('uses the first correction when a document has several', async () => {
    const d = await seedInvoice(server.db, { total: '10.00' })
    await setCreated(d, '2026-09-20T00:00:00Z')
    await addAudit(d, 'total', 'manual_correction', '2026-09-21T00:00:00Z')
    await addAudit(d, 'tax', 'manual_correction', '2026-09-25T00:00:00Z')
    const { json } = await analytics('?from=2026-09-01&to=2026-09-30')
    expect(json.turnaround.p50Hours).toBeCloseTo(24, 6)
  }, DB_TIMEOUT)

  it('groups confidence trend by ISO week with a Monday boundary', async () => {
    const mon = await seedInvoice(server.db, { total: '10.00' })
    const fri = await seedInvoice(server.db, { total: '20.00' })
    const other = await seedInvoice(server.db, { total: '30.00' })
    await setCreated(mon, '2026-09-21T00:00:00Z')
    await setCreated(fri, '2026-09-25T00:00:00Z')
    await setCreated(other, '2026-09-28T00:00:00Z')
    await server.db.query('UPDATE documents SET confidence = 0.8 WHERE id = ANY($1::uuid[])', [[mon, fri]])
    await server.db.query('UPDATE documents SET confidence = 0.4 WHERE id = $1', [other])
    // Ruling R15: `mon`'s only correction is on 2026-10-01, outside the window this
    // request reads, and it still counts, because the trend column is a lifetime share of
    // documents created in the week that were ever corrected.
    await addAudit(mon, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    const { json } = await analytics('?from=2026-09-01&to=2026-09-30')
    expect(json.confidenceTrend).toEqual([
      { week: '2026-09-21', avgConfidence: 0.8, correctionRate: 0.5 },
      { week: '2026-09-28', avgConfidence: 0.4, correctionRate: 0 },
    ])
  }, DB_TIMEOUT)

  it('filters every metric by kind', async () => {
    const inv = await seedInvoice(server.db, { total: '10.00' })
    const con = await seedInvoice(server.db, { total: '20.00' })
    await server.db.query("UPDATE documents SET kind = 'contract' WHERE id = $1", [con])
    await addFinding(inv, 'invoice.total.sum', 'total', 'error')
    await addFinding(con, 'contract.value.present', 'contract_value', 'error')
    const invoice = (await analytics('?kind=invoice')).json
    expect(invoice.byRule).toHaveLength(1)
    expect(invoice.correctionRate.documents).toBe(1)
    expect((await analytics('?kind=contract')).json.byRule[0]!.ruleId).toBe('contract.value.present')
  }, DB_TIMEOUT)

  it('never sees another tenant', async () => {
    const a = await seedInvoice(server.db, { total: '10.00' })
    await addFinding(a, 'invoice.total.sum', 'total', 'error')
    await server.db.query('UPDATE document_validation SET tenant_id = $2 WHERE document_id = $1', [a, OTHER])
    expect((await analytics()).json.byRule).toEqual([])
  }, DB_TIMEOUT)
})
