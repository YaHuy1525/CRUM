import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer } from '../helpers/test-server.js'
import type { Pool, PoolClient } from 'pg'

const TENANT = '00000000-0000-4000-8000-000000000001'
const USER = '00000000-0000-4000-8000-000000000002'

// A corrected PATCH now carries ~20 sequential queries over the remote pooler inside one
// transaction, and the seeding does too, so these cases can exceed vitest's 5s default.
const DB_TIMEOUT = 30_000

async function seedInvoice(
  db: Pool,
  fields: { subtotal?: string; tax?: string; total?: string; currency?: string },
): Promise<string> {
  const docResult = await db.query<{ id: string }>(
    `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status)
     VALUES ($1, $2, 'invoice', 'Correction Test Invoice', 'upload', $3, 'Test content', 'text/plain', 'ready')
     RETURNING id`,
    [TENANT, USER, `hash-correction-test-${crypto.randomUUID()}`],
  )
  const docId = docResult.rows[0]!.id

  const client: PoolClient = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', USER])
    await client.query('SELECT set_config($1, $2, true)', ['app.change_source', 'extraction'])
    // invoice_number and invoice_date are fixed and valid on purpose: the re-validation
    // cases assert openErrors, and the two presence rules for these columns would
    // otherwise keep the error count above zero no matter what the total reads.
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

describe('PATCH /api/documents/:id/invoices/:field', () => {
  let server: Awaited<ReturnType<typeof createTestServer>>
  let documentId: string

  beforeAll(async () => {
    server = await createTestServer()

    const db = server.db
    const docResult = await db.query<{ id: string }>(
      `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status)
       VALUES ($1, $2, 'invoice', 'Test Invoice', 'upload', $3, 'Test content', 'text/plain', 'ready')
       RETURNING id`,
      [TENANT, USER, `hash-correction-test-${crypto.randomUUID()}`],
    )
    documentId = docResult.rows[0]!.id

    // The audit trigger reads app.current_user_id / app.change_source from the
    // session.  Use a dedicated connection inside a transaction so SET LOCAL
    // scopes the variables to the trigger invocation.
    const client: PoolClient = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', USER])
      await client.query('SELECT set_config($1, $2, true)', ['app.change_source', 'extraction'])
      await client.query(
        `INSERT INTO invoices (document_id, vendor_name, total)
         VALUES ($1, 'Acme Corp', 1250.00)`,
        [documentId],
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  afterAll(async () => {
    await server.db.query('DELETE FROM documents WHERE id = $1', [documentId])
    await server.close()
  })

  it('updates a field and creates audit row', async () => {
    const res = await server.fetch(`/api/documents/${documentId}/invoices/total`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': TENANT,
        'x-user-id': USER,
        'x-user-role': 'admin',
      },
      body: JSON.stringify({
        value: 1300.0,
        reason: 'Customer confirmed correct amount',
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      openErrors: number
      openWarnings: number
      violations: unknown[]
    }
    expect(body.success).toBe(true)
    expect(typeof body.openErrors).toBe('number')
    expect(typeof body.openWarnings).toBe('number')
    expect(Array.isArray(body.violations)).toBe(true)

    const invoiceResult = await server.db.query<{ total: string }>(
      `SELECT total FROM invoices WHERE document_id = $1`,
      [documentId],
    )
    expect(invoiceResult.rows[0]!.total).toBe('1300')

    const auditResult = await server.db.query<{
      field_name: string
      action: string
      old_value: unknown
      new_value: unknown
      change_source: string
      reason: string | null
    }>(
      `SELECT field_name, action, old_value, new_value, change_source, reason
       FROM document_field_audit
       WHERE document_id = $1 AND field_name = 'total'
       ORDER BY changed_at DESC
       LIMIT 1`,
      [documentId],
    )
    expect(auditResult.rows[0]).toMatchObject({
      field_name: 'total',
      action: 'update',
      old_value: 1250,
      new_value: 1300,
      change_source: 'manual_correction',
      reason: 'Customer confirmed correct amount',
    })
  }, DB_TIMEOUT)

  it('rejects invalid field names', async () => {
    const res = await server.fetch(`/api/documents/${documentId}/invoices/invalid_field`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': TENANT,
        'x-user-id': USER,
        'x-user-role': 'admin',
      },
      body: JSON.stringify({ value: 'test' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('Field not correctable')
  })

  it('requires authentication', async () => {
    const res = await server.fetch(`/api/documents/${documentId}/invoices/total`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: 1300.0 }),
    })

    expect(res.status).toBe(401)
  })
})

describe('a correction re-validates in its own transaction and stamps its own row (H2)', () => {
  let server: Awaited<ReturnType<typeof createTestServer>>
  const created: string[] = []
  const HEADERS = {
    'x-tenant-id': TENANT,
    'x-user-id': USER,
    'x-user-role': 'admin',
    'content-type': 'application/json',
  }

  beforeAll(async () => {
    server = await createTestServer()
  })

  afterAll(async () => {
    if (created.length > 0) {
      await server.db.query(
        'DELETE FROM documents WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
        [TENANT, created],
      )
    }
    await server.close()
  })

  async function seed(fields: { subtotal?: string; tax?: string; total?: string }): Promise<string> {
    const doc = await seedInvoice(server.db, fields)
    created.push(doc)
    return doc
  }

  async function patch(doc: string, value: string, reason?: string): Promise<Response> {
    return server.fetch(`/api/documents/${doc}/invoices/total`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify(reason === undefined ? { value } : { value, reason }),
    })
  }

  it('clears the sum finding when the total is corrected, in the same response', async () => {
    const doc = await seed({ subtotal: '1000.00', tax: '100.00', total: '1200.00' })

    const first = await server.fetch('/api/documents/' + doc + '/validation', {
      method: 'POST', headers: HEADERS, body: '{}',
    })
    expect(first.status).toBe(200)
    const before = (await first.json()) as { violations: Array<{ ruleId: string }> }
    expect(before.violations.map((v) => v.ruleId)).toContain('invoice.total.sum')

    const res = await patch(doc, '1100.00', 'the footer of the page carried the right total')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      openErrors: number
      openWarnings: number
      violations: Array<{ ruleId: string }>
    }
    expect(body.success).toBe(true)
    expect(body.openErrors).toBe(0)
    expect(body.violations.map((v) => v.ruleId)).not.toContain('invoice.total.sum')

    // Plan Step 3: the findings were written on the transaction connection; a
    // different pooled connection must now carry the same rows.
    const stored = await server.db.query<{ rule_id: string }>(
      `SELECT rule_id FROM document_validation WHERE document_id = $1 AND tenant_id = $2`,
      [doc, TENANT],
    )
    expect(stored.rows.map((r) => r.rule_id).sort()).toEqual(body.violations.map((v) => v.ruleId).sort())
  }, DB_TIMEOUT)

  it('keeps the finding open when the correction does not fix it', async () => {
    const doc = await seed({ subtotal: '1000.00', tax: '100.00', total: '1200.00' })
    const res = await patch(doc, '1300.00')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { openErrors: number }
    expect(body.openErrors).toBeGreaterThan(0)
  }, DB_TIMEOUT)

  it('stamps the reason on this correction, not on an earlier one for the same field', async () => {
    const doc = await seed({ subtotal: '100.00', tax: '10.00', total: '110.00' })
    await patch(doc, '11.00', 'first reason that is long enough')
    await patch(doc, '12.00', 'second reason that is long enough')
    const rows = await server.db.query<{ reason: string | null }>(
      `SELECT reason FROM document_field_audit
       WHERE document_id = $1 AND field_name = 'total' AND action = 'update' ORDER BY changed_at`,
      [doc],
    )
    expect(rows.rows.map((r) => r.reason)).toEqual([
      'first reason that is long enough',
      'second reason that is long enough',
    ])
  }, DB_TIMEOUT)

  it('attributes both corrections on one pooled connection to their own actor', async () => {
    const docA = await seed({ total: '10.00' })
    const docB = await seed({ total: '20.00' })
    await patch(docA, '11.00')
    await patch(docB, '22.00')
    for (const doc of [docA, docB]) {
      const rows = await server.db.query<{ changed_by: string }>(
        `SELECT changed_by FROM document_field_audit
         WHERE document_id = $1 AND tenant_id = $2 AND action = 'update' AND field_name = 'total'`,
        [doc, TENANT],
      )
      expect(rows.rows.length).toBe(1)
      expect(rows.rows.every((r) => r.changed_by === USER)).toBe(true)
    }
  }, DB_TIMEOUT)
})

describe('a correction is bounded by the visibility the read path applies', () => {
  let server: Awaited<ReturnType<typeof createTestServer>>
  const OTHER_OWNER = '00000000-0000-4000-8000-0000000000aa'
  const HEADERS = {
    'content-type': 'application/json',
    'x-tenant-id': TENANT,
    'x-user-id': USER,
    'x-user-role': 'user',
  }
  let customerId = ''
  let documentId = ''

  beforeAll(async () => {
    server = await createTestServer()

    const customer = await server.db.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, owner_id)
       VALUES ($1, 'A Customer The Caller Does Not Share', $2) RETURNING id`,
      [TENANT, OTHER_OWNER],
    )
    customerId = customer.rows[0]!.id

    const doc = await server.db.query<{ id: string }>(
      `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status, customer_id)
       VALUES ($1, $2, 'invoice', 'A Invoice The Caller May Not Read', 'upload', $3, 'Test content', 'text/plain', 'ready', $4)
       RETURNING id`,
      [TENANT, OTHER_OWNER, `hash-unreadable-${crypto.randomUUID()}`, customerId],
    )
    documentId = doc.rows[0]!.id

    const client: PoolClient = await server.db.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', OTHER_OWNER])
      await client.query('SELECT set_config($1, $2, true)', ['app.change_source', 'extraction'])
      await client.query(
        `INSERT INTO invoices (document_id, vendor_name, subtotal, tax, total, currency)
         VALUES ($1, 'Hidden Vendor', '500.00', '50.00', '550.00', 'AUD')`,
        [documentId],
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }, DB_TIMEOUT)

  afterAll(async () => {
    await server.db.query('DELETE FROM documents WHERE tenant_id = $1 AND id = $2', [TENANT, documentId])
    await server.db.query('DELETE FROM customers WHERE tenant_id = $1 AND id = $2', [TENANT, customerId])
    await server.close()
  })

  it('404s the PATCH and leaves the stored value alone', async () => {
    const res = await server.fetch(`/api/documents/${documentId}/invoices/total`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ value: '999.00', reason: 'a reason long enough to satisfy the floor' }),
    })
    expect(res.status).toBe(404)
    expect(Object.keys(await res.json() as Record<string, unknown>)).not.toContain('openErrors')

    const row = await server.db.query<{ total: string }>(
      'SELECT total FROM invoices WHERE document_id = $1',
      [documentId],
    )
    expect(row.rows[0]!.total).toBe('550.00')

    const audit = await server.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM document_field_audit
       WHERE document_id = $1 AND tenant_id = $2 AND field_name = 'total' AND action = 'update'`,
      [documentId, TENANT],
    )
    expect(audit.rows[0]!.n).toBe('0')
  }, DB_TIMEOUT)

  it('still lets the owner correct the same document', async () => {
    const res = await server.fetch(`/api/documents/${documentId}/invoices/total`, {
      method: 'PATCH',
      headers: { ...HEADERS, 'x-user-id': OTHER_OWNER },
      body: JSON.stringify({ value: '560.00', reason: 'the vendor reissued the invoice' }),
    })
    expect(res.status).toBe(200)
    const row = await server.db.query<{ total: string }>(
      'SELECT total FROM invoices WHERE document_id = $1',
      [documentId],
    )
    expect(row.rows[0]!.total).toBe('560.00')
  }, DB_TIMEOUT)
})
