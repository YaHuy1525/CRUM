import { beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from '../helpers/test-server.js'
import type { Pool, PoolClient } from 'pg'

const TENANT = '00000000-0000-4000-8000-000000000001'
const USER = '00000000-0000-4000-8000-000000000002'
const HEADERS = {
  'x-tenant-id': TENANT,
  'x-user-id': USER,
  'x-user-role': 'admin',
  'content-type': 'application/json',
}

let server: TestServer
let documentId: string

beforeAll(async () => {
  server = await createTestServer()
  documentId = await seedInvoice(server.db, {
    subtotal: '1000.00', tax: '100.00', total: '1200.00', currency: 'AUD',
  })
})

async function seedInvoice(
  db: Pool,
  fields: { subtotal: string; tax: string; total: string; currency: string },
): Promise<string> {
  const docResult = await db.query<{ id: string }>(
    `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status)
     VALUES ($1, $2, 'invoice', 'Validation Test Invoice', 'upload', $3, 'Test content', 'text/plain', 'ready')
     RETURNING id`,
    [TENANT, USER, `hash-validation-test-${crypto.randomUUID()}`],
  )
  const docId = docResult.rows[0]!.id

  const client: PoolClient = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', USER])
    await client.query('SELECT set_config($1, $2, true)', ['app.change_source', 'extraction'])
    await client.query(
      `INSERT INTO invoices (document_id, vendor_name, subtotal, tax, total, currency)
       VALUES ($1, 'Test Vendor', $2, $3, $4, $5)`,
      [docId, fields.subtotal, fields.tax, fields.total, fields.currency],
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

async function get(path: string) {
  return server.fetch('/api/documents' + path, { headers: HEADERS })
}
async function post(path: string, body?: unknown) {
  return server.fetch('/api/documents' + path, {
    method: 'POST', headers: HEADERS, body: body === undefined ? '{}' : JSON.stringify(body),
  })
}

describe('GET /:id/validation', () => {
  it('refuses a non-uuid id with 400', async () => {
    expect((await get('/nope/validation')).status).toBe(400)
  })
  it('404s a document that is not this tenant', async () => {
    const res = await server.fetch('/api/documents/' + documentId + '/validation', {
      headers: { ...HEADERS, 'x-tenant-id': '00000000-0000-4000-8000-000000000077' },
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /:id/validation', () => {
  it('runs the engine and stores what it finds', async () => {
    const res = await post('/' + documentId + '/validation')
    expect(res.status).toBe(200)
    const body = await res.json() as { rulesetVersion: string; violations: Array<{ ruleId: string }> }
    expect(body.rulesetVersion).toBe('v1')
    expect(body.violations.map((v) => v.ruleId)).toContain('invoice.total.sum')
    expect((await get('/' + documentId + '/validation')).ok).toBe(true)
  })
  it('a second run does not double the rows', async () => {
    await post('/' + documentId + '/validation')
    const before = (await (await get('/' + documentId + '/validation')).json() as { violations: unknown[] }).violations.length
    await post('/' + documentId + '/validation')
    expect((await (await get('/' + documentId + '/validation')).json() as { violations: unknown[] }).violations.length).toBe(before)
  })
})

describe('POST /:id/validation/:violationId/waive', () => {
  it('requires a reason of at least eight characters', async () => {
    const [row] = (await (await get('/' + documentId + '/validation')).json() as { violations: Array<{ id: string }> }).violations
    expect((await post('/' + documentId + '/validation/' + row!.id + '/waive', { reason: 'oops' })).status).toBe(400)
    expect((await post('/' + documentId + '/validation/' + row!.id + '/waive', {})).status).toBe(400)
  })
  it('waives, then 409s a second attempt', async () => {
    const [row] = (await (await get('/' + documentId + '/validation')).json() as { violations: Array<{ id: string }> }).violations
    const ok = await post('/' + documentId + '/validation/' + row!.id + '/waive', {
      reason: 'credit note nets this invoice off',
    })
    expect(ok.status).toBe(200)
    expect((await ok.json() as { violation: { status: string } }).violation.status).toBe('waived')
    expect((await post('/' + documentId + '/validation/' + row!.id + '/waive', {
      reason: 'trying to waive it a second time',
    })).status).toBe(409)
  })
  it('404s a violation belonging to another tenant', async () => {
    const res = await server.fetch(
      '/api/documents/' + documentId + '/validation/00000000-0000-4000-8000-000000000000/waive',
      { method: 'POST', headers: HEADERS, body: JSON.stringify({ reason: 'a long enough reason' }) },
    )
    expect(res.status).toBe(404)
  })
})

describe('H3, the detail responses stop leaking internal join columns', () => {
  it('never returns invoice_field_confidence or contract_field_confidence', async () => {
    for (const path of ['/' + documentId, '/' + documentId + '/invoice']) {
      const text = await (await get(path)).text()
      expect(text).not.toMatch(/invoice_field_confidence|contract_field_confidence/)
    }
  })
})
