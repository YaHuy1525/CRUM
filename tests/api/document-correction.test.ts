import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer } from '../helpers/test-server.js'
import type { PoolClient } from 'pg'

const TENANT = '00000000-0000-4000-8000-000000000001'
const USER = '00000000-0000-4000-8000-000000000002'

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
    const body = (await res.json()) as { success: boolean }
    expect(body.success).toBe(true)

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
  })

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
