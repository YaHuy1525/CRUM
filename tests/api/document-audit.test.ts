import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestServer } from '../helpers/test-server.js'
import type { PoolClient } from 'pg'

const TENANT = '00000000-0000-4000-8000-000000000001'
const USER = '00000000-0000-4000-8000-000000000002'

interface AuditEntry {
  document_id: string
  tenant_id: string
  table_name: string
  field_name: string
  action: string
  old_value: unknown
  new_value: unknown
  changed_by: string | null
  changed_at: string
  change_source: string
  reason: string | null
}

interface AuditResponseBody {
  audit: AuditEntry[]
}

describe('GET /api/documents/:id/audit', () => {
  let server: Awaited<ReturnType<typeof createTestServer>>
  let documentId: string

  beforeAll(async () => {
    server = await createTestServer()

    const db = server.db
    const docResult = await db.query<{ id: string }>(
      `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status)
       VALUES ($1, $2, 'invoice', 'Test Invoice', 'upload', $3, 'Test content', 'text/plain', 'ready')
       RETURNING id`,
      [TENANT, USER, `hash-audit-test-${crypto.randomUUID()}`],
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

  it('returns audit trail for a document', async () => {
    const res = await server.fetch(`/api/documents/${documentId}/audit`, {
      headers: {
        'x-tenant-id': TENANT,
        'x-user-id': USER,
        'x-user-role': 'admin',
      },
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as AuditResponseBody
    expect(body.audit).toBeDefined()
    expect(Array.isArray(body.audit)).toBe(true)
    expect(body.audit.length).toBeGreaterThan(0)

    const firstAudit = body.audit[0]
    expect(firstAudit).toMatchObject({
      document_id: documentId,
      tenant_id: TENANT,
      table_name: 'invoices',
    })
    expect(firstAudit).toHaveProperty('field_name')
    expect(firstAudit).toHaveProperty('action')
    expect(firstAudit).toHaveProperty('changed_at')
  })

  it('returns 404 for non-existent document', async () => {
    const fakeId = '00000000-0000-4000-8000-000000000999'
    const res = await server.fetch(`/api/documents/${fakeId}/audit`, {
      headers: {
        'x-tenant-id': TENANT,
        'x-user-id': USER,
        'x-user-role': 'admin',
      },
    })

    expect(res.status).toBe(404)
  })

  it('enforces tenant isolation', async () => {
    const otherTenant = '11111111-1111-4111-8111-111111111111'
    const res = await server.fetch(`/api/documents/${documentId}/audit`, {
      headers: {
        'x-tenant-id': otherTenant,
        'x-user-id': USER,
        'x-user-role': 'admin',
      },
    })

    expect(res.status).toBe(404)
  })
})
