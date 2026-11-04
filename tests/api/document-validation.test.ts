import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

async function seedContract(db: Pool): Promise<string> {
  const docResult = await db.query<{ id: string }>(
    `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status)
     VALUES ($1, $2, 'contract', 'Validation Test Contract', 'upload', $3, 'Test content', 'text/plain', 'ready')
     RETURNING id`,
    [TENANT, USER, `hash-validation-contract-${crypto.randomUUID()}`],
  )
  const docId = docResult.rows[0]!.id
  await db.query(
    `INSERT INTO contracts (document_id, counterparty, contract_value, currency, field_confidence)
     VALUES ($1, 'Test Counterparty', 5000.00, 'AUD', '{"counterparty": 0.42}'::jsonb)`,
    [docId],
  )
  return docId
}

// A kind-'other' document exists in the tenant and is listed by document_id, but
// re-validation refuses its kind, so it is how the "no measured re-run" branch is reached.
async function seedOtherDocument(db: Pool): Promise<string> {
  const docResult = await db.query<{ id: string }>(
    `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status)
     VALUES ($1, $2, 'other', 'Validation Test Attachment', 'upload', $3, 'Test content', 'text/plain', 'ready')
     RETURNING id`,
    [TENANT, USER, `hash-validation-other-${crypto.randomUUID()}`],
  )
  return docResult.rows[0]!.id
}

async function addFinding(docId: string, ruleId: string, field: string, severity: 'error' | 'warning') {
  const r = await server.db.query<{ id: string }>(
    `INSERT INTO document_validation
       (document_id, tenant_id, ruleset_version, severity, rule_id, field_name, message)
     VALUES ($1, $2, 'v1', $3, $4, $5, 'seeded by document-validation test')
     RETURNING id`,
    [docId, TENANT, severity, ruleId, field],
  )
  return r.rows[0]!.id
}

async function openFindingOf(docId: string): Promise<string> {
  const { violations } = await (await get('/' + docId + '/validation'))
    .json() as { violations: Array<{ id: string; status: string }> }
  const open = violations.find((v) => v.status === 'open')
  if (!open) throw new Error(`no open finding on ${docId}`)
  return open.id
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
  let contractId = ''

  beforeAll(async () => {
    await server.db.query(
      `UPDATE invoices SET field_confidence = '{"total": 0.42}'::jsonb WHERE document_id = $1`,
      [documentId],
    )
    contractId = await seedContract(server.db)
  })

  afterAll(async () => {
    await server.db.query(
      'DELETE FROM documents WHERE tenant_id = $1 AND id = $2',
      [TENANT, contractId],
    )
  })

  it('answers 200 and never returns invoice_field_confidence or contract_field_confidence', async () => {
    for (const path of ['/' + documentId, '/' + documentId + '/invoice', '/' + contractId + '/contract']) {
      const res = await get(path)
      expect(res.status).toBe(200)
      expect(await res.text()).not.toMatch(/invoice_field_confidence|contract_field_confidence/)
    }
  })
})

describe('a waiver is bound to the document named in its own path', () => {
  const created: string[] = []

  afterAll(async () => {
    if (created.length > 0) {
      await server.db.query(
        'DELETE FROM documents WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
        [TENANT, created],
      )
    }
  })

  it('404s a same-tenant finding that belongs to a different document', async () => {
    const other = await seedInvoice(server.db, {
      subtotal: '10.00', tax: '1.00', total: '99.00', currency: 'AUD',
    })
    created.push(other)
    expect((await post('/' + other + '/validation')).status).toBe(200)
    const foreignFinding = await openFindingOf(other)

    const res = await post('/' + documentId + '/validation/' + foreignFinding + '/waive', {
      reason: 'a reason long enough to satisfy the floor',
    })
    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toBe('not_found')

    const after = await (await get('/' + other + '/validation'))
      .json() as { violations: Array<{ id: string; status: string }> }
    expect(after.violations.find((v) => v.id === foreignFinding)?.status).toBe('open')
  })

  it('refuses a non-string reason with 400 rather than a 500 crash', async () => {
    const finding = await openFindingOf(documentId)
    const res = await server.fetch(
      '/api/documents/' + documentId + '/validation/' + finding + '/waive',
      { method: 'POST', headers: HEADERS, body: JSON.stringify({ reason: 123 }) },
    )
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('reason_required')
  })

  it('omits openErrors when the re-run measured nothing', async () => {
    const doc = await seedOtherDocument(server.db)
    created.push(doc)
    const finding = await addFinding(doc, 'invoice.total.sum', 'total', 'error')

    const res = await post('/' + doc + '/validation/' + finding + '/waive', {
      reason: 'a reason long enough to satisfy the floor',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { violation: { status: string }; openErrors?: number }
    expect(body.violation.status).toBe('waived')
    expect(body).not.toHaveProperty('openErrors')
  })
})
