import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from '../helpers/test-server.js'
import type { Pool, PoolClient } from 'pg'

const TENANT = 'a8000000-0000-4000-8000-000000000013'
const USER = '00000000-0000-4000-8000-000000000002'
const HEADERS: Record<string, string> = {
  'x-tenant-id': TENANT,
  'x-user-id': USER,
  'x-user-role': 'admin',
}

const DB_TIMEOUT = 30_000

interface ExtendedAnalyticsBody {
  byCustomer: Array<{ customer: string; documents: number; documentsWithFindings: number; totalFindings: number }>
  byVendor: Array<{ vendor: string; documents: number; documentsWithFindings: number; totalFindings: number }>
  heatmap: Array<{ kind: string; field: string; corrections: number }>
  error?: string
}

let server: TestServer

async function seedCustomer(db: Pool, name: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO customers (tenant_id, name, owner_id) VALUES ($1, $2, $3) RETURNING id`,
    [TENANT, name, USER],
  )
  return r.rows[0]!.id
}

async function seedDocument(db: Pool, fields: { kind: 'invoice' | 'contract'; customerId?: string | null }): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status, customer_id)
     VALUES ($1, $2, $3, 'Test doc', 'upload', $4, 'Test content', 'text/plain', 'ready', $5)
     RETURNING id`,
    [TENANT, USER, fields.kind, `hash-ext-${crypto.randomUUID()}`, fields.customerId ?? null],
  )
  return r.rows[0]!.id
}

async function seedInvoice(db: Pool, docId: string, vendorName: string) {
  const client: PoolClient = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', USER])
    await client.query('SELECT set_config($1, $2, true)', ['app.change_source', 'extraction'])
    await client.query(
      `INSERT INTO invoices (document_id, vendor_name, invoice_number, invoice_date, subtotal, tax, total, currency)
       VALUES ($1, $2, 'INV-1', '2026-01-15', '100.00', '10.00', '110.00', 'USD')`,
      [docId, vendorName],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

async function addFinding(docId: string, ruleId: string, field: string, severity: 'error' | 'warning' = 'error') {
  await server.db.query(
    `INSERT INTO document_validation
       (document_id, tenant_id, ruleset_version, severity, rule_id, field_name, message)
     VALUES ($1, $2, 'v1', $3, $4, $5, 'seeded by extended analytics test')`,
    [docId, TENANT, severity, ruleId, field],
  )
}

async function addAudit(docId: string, field: string, source: string, at: string) {
  await server.db.query(
    `INSERT INTO document_field_audit
       (document_id, tenant_id, table_name, field_name, action, new_value, changed_by, changed_at, change_source)
     VALUES ($1, $2, 'invoices', $3, 'update', $4::jsonb, $5, $6::timestamptz, $7)`,
    [docId, TENANT, field, JSON.stringify('x'), USER, at, source],
  )
}

async function wipe() {
  await server.db.query('DELETE FROM document_field_audit WHERE tenant_id = $1', [TENANT])
  await server.db.query('DELETE FROM document_validation WHERE tenant_id = $1', [TENANT])
  await server.db.query('DELETE FROM documents WHERE tenant_id = $1', [TENANT])
  await server.db.query('DELETE FROM customers WHERE tenant_id = $1', [TENANT])
}

async function analytics(query = '') {
  const res = await server.fetch('/api/documents/analytics/review' + query, { headers: HEADERS })
  return { status: res.status, json: (await res.json()) as ExtendedAnalyticsBody }
}

beforeAll(async () => {
  server = await createTestServer()
}, DB_TIMEOUT)

afterAll(async () => {
  await wipe()
}, DB_TIMEOUT)

describe('byCustomer analytics', () => {
  beforeEach(async () => {
    await wipe()
  }, DB_TIMEOUT)

  it('returns top customers by finding count', async () => {
    const c1 = await seedCustomer(server.db, 'Acme Corp')
    const c2 = await seedCustomer(server.db, 'Globex')

    const doc1 = await seedDocument(server.db, { kind: 'invoice', customerId: c1 })
    const doc2 = await seedDocument(server.db, { kind: 'invoice', customerId: c1 })
    const doc3 = await seedDocument(server.db, { kind: 'invoice', customerId: c2 })

    await addFinding(doc1, 'rule-1', 'total', 'error')
    await addFinding(doc2, 'rule-1', 'total', 'error')
    await addFinding(doc3, 'rule-1', 'total', 'error')

    const { json } = await analytics('?from=2026-01-01&to=2026-12-31')
    expect(json.byCustomer).toHaveLength(2)
    expect(json.byCustomer[0]!.customer).toBe('Acme Corp')
    expect(json.byCustomer[0]!.documents).toBe(2)
    expect(json.byCustomer[0]!.documentsWithFindings).toBe(2)
    expect(json.byCustomer[0]!.totalFindings).toBe(2)
    expect(json.byCustomer[1]!.customer).toBe('Globex')
    expect(json.byCustomer[1]!.documents).toBe(1)
  }, DB_TIMEOUT)

  it('excludes documents without a customer', async () => {
    const c1 = await seedCustomer(server.db, 'Acme Corp')
    await seedDocument(server.db, { kind: 'invoice', customerId: c1 })
    await seedDocument(server.db, { kind: 'invoice', customerId: null })

    const { json } = await analytics('?from=2026-01-01&to=2026-12-31')
    const totalDocs = json.byCustomer.reduce((sum, c) => sum + c.documents, 0)
    expect(totalDocs).toBe(1)
  }, DB_TIMEOUT)

  it('returns empty array when no customers exist', async () => {
    await seedDocument(server.db, { kind: 'invoice', customerId: null })
    const { json } = await analytics('?from=2026-01-01&to=2026-12-31')
    expect(json.byCustomer).toEqual([])
  }, DB_TIMEOUT)
})

describe('byVendor analytics', () => {
  beforeEach(async () => {
    await wipe()
  }, DB_TIMEOUT)

  it('returns top vendors by finding count (invoices only)', async () => {
    const doc1 = await seedDocument(server.db, { kind: 'invoice' })
    const doc2 = await seedDocument(server.db, { kind: 'invoice' })
    const doc3 = await seedDocument(server.db, { kind: 'contract' })

    await seedInvoice(server.db, doc1, 'Vendor A')
    await seedInvoice(server.db, doc2, 'Vendor A')
    await seedInvoice(server.db, doc3, 'Vendor B')

    await addFinding(doc1, 'rule-1', 'total', 'error')
    await addFinding(doc2, 'rule-1', 'total', 'error')

    const { json } = await analytics('?from=2026-01-01&to=2026-12-31')
    expect(json.byVendor).toHaveLength(1)
    expect(json.byVendor[0]!.vendor).toBe('Vendor A')
    expect(json.byVendor[0]!.documents).toBe(2)
    expect(json.byVendor[0]!.totalFindings).toBe(2)
  }, DB_TIMEOUT)

  it('returns empty array when kind filter is contract', async () => {
    const doc1 = await seedDocument(server.db, { kind: 'invoice' })
    await seedInvoice(server.db, doc1, 'Vendor A')
    await addFinding(doc1, 'rule-1', 'total', 'error')

    const { json } = await analytics('?from=2026-01-01&to=2026-12-31&kind=contract')
    expect(json.byVendor).toEqual([])
  }, DB_TIMEOUT)
})

describe('heatmap analytics', () => {
  beforeEach(async () => {
    await wipe()
  }, DB_TIMEOUT)

  it('returns top field-kind combinations by correction count', async () => {
    const doc1 = await seedDocument(server.db, { kind: 'invoice' })
    const doc2 = await seedDocument(server.db, { kind: 'contract' })

    await addAudit(doc1, 'total_amount', 'manual_correction', '2026-10-01T00:00:00Z')
    await addAudit(doc1, 'total_amount', 'manual_correction', '2026-10-02T00:00:00Z')
    await addAudit(doc1, 'vendor_name', 'manual_correction', '2026-10-02T00:00:00Z')
    await addAudit(doc2, 'total_amount', 'manual_correction', '2026-10-02T00:00:00Z')

    const { json } = await analytics('?from=2026-01-01&to=2026-12-31')
    expect(json.heatmap).toHaveLength(3)
    expect(json.heatmap[0]).toEqual({ kind: 'invoice', field: 'total_amount', corrections: 2 })
    // When corrections are tied, ORDER BY is kind ASC, field ASC, so contract comes before invoice
    expect(json.heatmap[1]).toEqual({ kind: 'contract', field: 'total_amount', corrections: 1 })
    expect(json.heatmap[2]).toEqual({ kind: 'invoice', field: 'vendor_name', corrections: 1 })
  }, DB_TIMEOUT)

  it('respects kind filter', async () => {
    const doc1 = await seedDocument(server.db, { kind: 'invoice' })
    const doc2 = await seedDocument(server.db, { kind: 'contract' })

    await addAudit(doc1, 'total_amount', 'manual_correction', '2026-10-01T00:00:00Z')
    await addAudit(doc2, 'total_amount', 'manual_correction', '2026-10-01T00:00:00Z')

    const { json } = await analytics('?from=2026-01-01&to=2026-12-31&kind=invoice')
    expect(json.heatmap.every((h) => h.kind === 'invoice')).toBe(true)
  }, DB_TIMEOUT)

  it('excludes non-correction audit rows', async () => {
    const doc1 = await seedDocument(server.db, { kind: 'invoice' })
    await addAudit(doc1, 'total_amount', 'extraction', '2026-10-01T00:00:00Z')

    const { json } = await analytics('?from=2026-01-01&to=2026-12-31')
    expect(json.heatmap).toEqual([])
  }, DB_TIMEOUT)
})
