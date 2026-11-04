import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createTestServer } from '../helpers/test-server.js'
import type { PoolClient } from 'pg'

const TENANT = '00000000-0000-4000-8000-000000000001'
const USER = '00000000-0000-4000-8000-000000000002'

// The same allowance `tests/api/document-correction.test.ts` and
// `tests/api/review-queue.test.ts` give every database case: one seed plus one
// request crosses the remote pooler, and vitest's default 5000 ms is not enough.
const DB_TIMEOUT = 30_000

// Ruling R67's two cases run in a tenant this file owns alone. The `TENANT` above is
// seeded by nine other database suites, and Vitest runs files in parallel worker
// processes, so a `wipe()` scoped to it would delete rows those suites assert on.
// `a6000000-...011` was measured unclaimed across `tests/`; `documents.tenant_id`
// carries no foreign key, so a fresh tenant needs no `tenants` row and no migration.
const R67_TENANT = 'a6000000-0000-4000-8000-000000000011'
const R67_OWNER = 'a6000000-0000-4000-8000-0000000000a1'
const R67_LOOKIE = 'a6000000-0000-4000-8000-0000000000a2'

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

// Ruling R67: `GET /:id/audit` is the document read that used to gate on tenant alone,
// so a `user` holding a uuid could pull another member's whole change history out of the
// same tenant. The two cases below are the rule and its control, in that order: the 404
// only means something because the same document answers 200 with rows for an `admin`.
describe('GET /api/documents/:id/audit visibility (ruling R67)', () => {
  let scoped: Awaited<ReturnType<typeof createTestServer>>

  function asMember(userId: string, role: 'user' | 'admin'): Record<string, string> {
    return { 'x-tenant-id': R67_TENANT, 'x-user-id': userId, 'x-user-role': role }
  }

  // Child-first, and only ever this file's tenant: `document_field_audit` and
  // `invoices` hang off `documents` (both ON DELETE CASCADE), `documents` hangs off
  // `customers`. The file's original tenant is never touched, because the three cases
  // above depend on the row their `beforeAll` seeded there.
  async function wipeScoped(): Promise<void> {
    await scoped.db.query('DELETE FROM document_field_audit WHERE tenant_id = $1', [R67_TENANT])
    await scoped.db.query(
      'DELETE FROM invoices WHERE document_id IN (SELECT id FROM documents WHERE tenant_id = $1)',
      [R67_TENANT],
    )
    await scoped.db.query('DELETE FROM documents WHERE tenant_id = $1', [R67_TENANT])
    await scoped.db.query('DELETE FROM customers WHERE tenant_id = $1', [R67_TENANT])
  }

  // The customer is owned by OWNER alone and `team_member_ids` keeps its default empty
  // array, so the only way another member can reach this document is a missing predicate.
  async function seedOwnedInvoice(): Promise<string> {
    const customer = await scoped.db.query<{ id: string }>(
      `INSERT INTO customers (tenant_id, name, owner_id)
       VALUES ($1, 'R67 Audit Customer', $2)
       RETURNING id`,
      [R67_TENANT, R67_OWNER],
    )
    const doc = await scoped.db.query<{ id: string }>(
      `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status, customer_id)
       VALUES ($1, $2, 'invoice', 'R67 Audit Invoice', 'upload', $3, 'Test content', 'text/plain', 'ready', $4)
       RETURNING id`,
      [R67_TENANT, R67_OWNER, `hash-audit-r67-${crypto.randomUUID()}`, customer.rows[0]!.id],
    )
    const documentId = doc.rows[0]!.id

    // Same dedicated connection the file's `beforeAll` uses: the trigger reads
    // app.current_user_id / app.change_source from the session, and the INSERT below
    // is what puts the audit rows this suite then reads on the document.
    const client: PoolClient = await scoped.db.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', R67_OWNER])
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
    return documentId
  }

  beforeAll(async () => {
    scoped = await createTestServer()
  }, DB_TIMEOUT)

  beforeEach(async () => {
    await wipeScoped()
  }, DB_TIMEOUT)

  afterAll(async () => {
    await wipeScoped()
    await scoped.close()
  }, DB_TIMEOUT)

  it('404s when a user asks for another member\'s audit trail', async () => {
    const documentId = await seedOwnedInvoice()

    const res = await scoped.fetch(`/api/documents/${documentId}/audit`, {
      headers: asMember(R67_LOOKIE, 'user'),
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  }, DB_TIMEOUT)

  it('returns the rows for an admin in the same tenant', async () => {
    const documentId = await seedOwnedInvoice()

    const res = await scoped.fetch(`/api/documents/${documentId}/audit`, {
      headers: asMember(R67_LOOKIE, 'admin'),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as AuditResponseBody
    expect(body.audit.length).toBeGreaterThan(0)
    expect(body.audit.every((row) => row.document_id === documentId)).toBe(true)
    expect(body.audit.every((row) => row.tenant_id === R67_TENANT)).toBe(true)
  }, DB_TIMEOUT)
})
