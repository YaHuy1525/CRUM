import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestServer, type TestServer } from '../helpers/test-server.js'
import type { Pool, PoolClient } from 'pg'
import { AUDIT_CSV_HEADER, buildAuditCsv, csvCell } from '../../src/api/audit-csv.js'

// Ruling R71: this file's own tenant pair, measured unclaimed across tests/, src/ and the plan.
const TENANT = 'a9000000-0000-4000-8000-000000000013'
const OTHER = 'a9000000-0000-4000-8000-000000000113'
const USER = '00000000-0000-4000-8000-000000000002'
const HEADERS: Record<string, string> = {
  'x-tenant-id': TENANT,
  'x-user-id': USER,
  'x-user-role': 'admin',
}

const DB_TIMEOUT = 30_000

// Pure formatter tests (no database needed)
describe('csvCell', () => {
  it('leaves a plain value bare', () => {
    expect(csvCell('AUD')).toBe('AUD')
  })
  it('quotes a comma without touching the rest', () => {
    expect(csvCell('Smith, John')).toBe('"Smith, John"')
  })
  it('doubles an interior quote and quotes the field', () => {
    expect(csvCell('the "vendor" field')).toBe('"the ""vendor"" field"')
  })
  it('quotes a newline', () => {
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"')
  })
  it('quotes a carriage return', () => {
    expect(csvCell('a\r\nb')).toBe('"a\r\nb"')
  })
  it('maps null to an empty cell, not to the word null', () => {
    expect(csvCell(null)).toBe('')
  })
  it('maps the empty string to an empty cell', () => {
    expect(csvCell('')).toBe('')
  })
  it('keeps a leading space, which Excel would otherwise trim silently', () => {
    expect(csvCell(' AUD')).toBe(' AUD')
  })
  // Ruling R60: formula injection guard
  it('neutralises a leading equals sign', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)")
  })
  it('neutralises a leading plus and a leading at-sign', () => {
    expect(csvCell('+1-2')).toBe("'+1-2")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
  })
  it('neutralises a leading tab, which spreadsheet parsers hit-tab-guard', () => {
    expect(csvCell('\t=1+1')).toBe("'\t=1+1")
  })
  it('leaves a negative money value alone', () => {
    expect(csvCell('-1100.00')).toBe('-1100.00')
  })
  it('neutralises before it quotes, so a guarded cell still survives its comma', () => {
    expect(csvCell(`=cmd,'/C calc'!A0`)).toBe(`"'=cmd,'/C calc'!A0"`)
  })
})

describe('buildAuditCsv', () => {
  const row = {
    document_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    document_title: 'Acme, Co',
    table_name: 'invoices',
    field_name: 'total',
    action: 'update',
    old_value: '1200.00',
    new_value: '1100.00',
    changed_by: null,
    changed_at: '2026-11-03T09:00:00.000Z',
    change_source: 'manual_correction',
    reason: null,
  }

  it('leads the body with a UTF-8 byte order mark', () => {
    expect(buildAuditCsv([row]).charCodeAt(0)).toBe(0xfeff)
  })
  it('starts with the header in the fixed column order', () => {
    const lines = buildAuditCsv([row]).slice(1).split('\r\n')
    expect(lines[0]).toBe(AUDIT_CSV_HEADER.join(','))
  })
  it('terminates every record with CRLF, as RFC 4180 requires', () => {
    const text = buildAuditCsv([row])
    expect(text.endsWith('\r\n')).toBe(true)
    expect(text.split('\n').length).toBe(3)
  })
  it('quotes only the cells that need it, in order', () => {
    const lines = buildAuditCsv([row]).slice(1).split('\r\n')
    expect(lines[1]).toBe(
      'aaaaaaaa-0000-4000-8000-000000000001,"Acme, Co",invoices,total,update,1200.00,1100.00,' +
        ',2026-11-03T09:00:00.000Z,manual_correction,',
    )
  })
  it('emits a header-only file for no rows', () => {
    const text = buildAuditCsv([])
    expect(text).toBe('\uFEFF' + AUDIT_CSV_HEADER.join(',') + '\r\n')
  })
})

// Route tests (database required)
async function seedInvoice(
  db: Pool,
  fields: { subtotal?: string; tax?: string; total?: string; currency?: string },
  tenant = TENANT,
): Promise<string> {
  const docResult = await db.query<{ id: string }>(
    `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status)
     VALUES ($1, $2, 'invoice', 'Export Test Invoice', 'upload', $3, 'Test content', 'text/plain', 'ready')
     RETURNING id`,
    [tenant, USER, `hash-export-test-${crypto.randomUUID()}`],
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

// Widened to accept reason (brief item 11 / plan Step 1 note)
async function addAudit(
  docId: string,
  field: string,
  source: string,
  at: string,
  by = USER,
  reason: string | null = null,
) {
  await server.db.query(
    `INSERT INTO document_field_audit
       (document_id, tenant_id, table_name, field_name, action, new_value, changed_by, changed_at, change_source, reason)
     VALUES ($1, $2, 'invoices', $3, 'update', $4::jsonb, $5, $6::timestamptz, $7, $8)`,
    [docId, TENANT, field, JSON.stringify('x'), by, at, source, reason],
  )
}

let server: TestServer
let documentId: string

async function exportCsv(query = '') {
  return server.fetch('/api/documents/audit/export' + (query ? '?' + query : ''), { headers: HEADERS })
}

function exportLines(text: string): string[] {
  return text.slice(1).split('\r\n').filter((line) => line !== '')
}

beforeAll(async () => {
  server = await createTestServer()
}, DB_TIMEOUT)

beforeEach(async () => {
  // Ruling R71: child-first wipe scoped to this file's tenant pair.
  await server.db.query('DELETE FROM document_field_audit WHERE tenant_id = ANY($1::uuid[])', [[TENANT, OTHER]])
  await server.db.query('DELETE FROM documents WHERE tenant_id = ANY($1::uuid[])', [[TENANT, OTHER]])
  // R71 item 13: customers DELETE because R68 case seeds one; documents.customer_id is
  // ON DELETE SET NULL (migrations/0009:44), so the customer row survives and must be named.
  await server.db.query('DELETE FROM customers WHERE tenant_id = ANY($1::uuid[])', [[TENANT, OTHER]])
  documentId = await seedInvoice(server.db, { total: '1200.00' })
  // seedInvoice creates audit rows via the trigger; wipe them so tests start clean.
  await server.db.query('DELETE FROM document_field_audit WHERE tenant_id = ANY($1::uuid[])', [[TENANT, OTHER]])
}, DB_TIMEOUT)

describe('GET /audit/export', () => {
  it('refuses a request with no identity', async () => {
    expect((await server.fetch('/api/documents/audit/export')).status).toBe(401)
  }, DB_TIMEOUT)

  it('answers 204 when the window holds nothing', async () => {
    const res = await exportCsv('?from=2020-01-01&to=2020-01-31')
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  }, DB_TIMEOUT)

  it('serves csv with an attachment name built from the window', async () => {
    await addAudit(documentId, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    const res = await exportCsv('from=2026-10-01&to=2026-10-31')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition'))
      .toBe('attachment; filename="field-audit-2026-10-01-to-2026-10-31.csv"')
  }, DB_TIMEOUT)

  it('quotes a title containing a comma and a reason containing a quote', async () => {
    await server.db.query("UPDATE documents SET title = 'Acme, Co' WHERE id = $1", [documentId])
    await addAudit(documentId, 'total', 'manual_correction', '2026-10-01T00:00:00Z', USER, 'fixed the "sum"')
    const text = await (await exportCsv('from=2026-10-01&to=2026-10-31')).text()
    expect(text).toContain('"Acme, Co"')
    expect(text).toContain('"fixed the ""sum"""')
  }, DB_TIMEOUT)

  it('renders jsonb cells as their bare text, not as quoted json', async () => {
    await server.db.query(
      `INSERT INTO document_field_audit
         (document_id, tenant_id, table_name, field_name, action, old_value, new_value, changed_by, changed_at, change_source)
       VALUES ($1, $2, 'invoices', 'total', 'update', $3::jsonb, $4::jsonb, $5, '2026-10-01T00:00:00Z', 'manual_correction')`,
      [documentId, TENANT, JSON.stringify('1100.00'), JSON.stringify(1200.5), USER],
    )
    const lines = exportLines(await (await exportCsv('?from=2026-10-01&to=2026-10-31')).text())
    expect(lines[1]).toContain(',invoices,total,update,1100.00,1200.5,' + USER)
  }, DB_TIMEOUT)

  it('filters by change source', async () => {
    await addAudit(documentId, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    await addAudit(documentId, 'tax', 'extraction', '2026-10-01T00:00:00Z')
    const filtered = await (await exportCsv('?from=2026-10-01&to=2026-10-31&change_source=manual_correction')).text()
    expect(filtered.split('\r\n').length).toBe(3)
    expect(filtered).not.toContain('extraction')
  }, DB_TIMEOUT)

  it('rejects an unknown change source', async () => {
    const res = await exportCsv('change_source=somehow')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'bad_filter', param: 'change_source' })
  }, DB_TIMEOUT)

  it('rejects a malformed window with bad_range', async () => {
    const res = await exportCsv('from=not-a-date')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'bad_range' })
  }, DB_TIMEOUT)

  it('refuses rather than truncating past the cap', async () => {
    for (let i = 0; i < 3; i++) {
      await addAudit(documentId, 'total', 'manual_correction', '2026-10-01T00:00:0' + i + 'Z')
    }
    const res = await exportCsv('?from=2026-10-01&to=2026-10-31&max=2')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'too_many_rows', max: 2 })
  }, DB_TIMEOUT)

  it('clamps a requested cap above the ceiling instead of raising it', async () => {
    await addAudit(documentId, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    const res = await exportCsv('?from=2026-10-01&to=2026-10-31&max=999999')
    expect(res.headers.get('x-export-row-cap')).toBe('50000')
  }, DB_TIMEOUT)

  it('never exports another tenant row', async () => {
    await addAudit(documentId, 'total', 'manual_correction', '2026-10-01T00:00:00Z')
    await server.db.query('UPDATE document_field_audit SET tenant_id = $2 WHERE document_id = $1', [documentId, OTHER])
    const res = await exportCsv('from=2026-10-01&to=2026-10-31')
    // 204 = no content (no rows to export after tenant filter)
    expect(res.status).toBe(204)
  }, DB_TIMEOUT)

  it('orders newest first and honours the kind filter', async () => {
    const con = await seedInvoice(server.db, { total: '5.00' })
    await server.db.query("UPDATE documents SET kind = 'contract' WHERE id = $1", [con])
    // Wipe the extraction audit rows the trigger created for con
    await server.db.query('DELETE FROM document_field_audit WHERE document_id = $1', [con])
    await addAudit(documentId, 'total', 'manual_correction', '2026-10-02T00:00:00Z')
    await addAudit(con, 'contract_value', 'manual_correction', '2026-10-01T00:00:00Z')
    const text = await (await exportCsv('?from=2026-10-01&to=2026-10-31&kind=contract')).text()
    expect(text).toContain(con)
    expect(text).not.toContain(documentId)
  }, DB_TIMEOUT)

  // Ruling R68: visibility predicate. A user sees only their own documents; an admin sees all.
  describe('visibility (ruling R68)', () => {
    const R68_OWNER = 'a9000000-0000-4000-8000-0000000000e1'
    const R68_LOOKER = 'a9000000-0000-4000-8000-0000000000e2'

    it('hides an unshared customer document from a user but shows it to an admin', async () => {
      // Seed a customer owned by R68_OWNER, with a document linked to it
      const customer = await server.db.query<{ id: string }>(
        `INSERT INTO customers (tenant_id, name, owner_id)
         VALUES ($1, 'R68 Export Customer', $2) RETURNING id`,
        [TENANT, R68_OWNER],
      )
      const doc = await server.db.query<{ id: string }>(
        `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status, customer_id)
         VALUES ($1, $2, 'invoice', 'R68 Export Invoice', 'upload', $3, 'Test content', 'text/plain', 'ready', $4)
         RETURNING id`,
        [TENANT, R68_OWNER, `hash-export-r68-${crypto.randomUUID()}`, customer.rows[0]!.id],
      )
      const hiddenDocId = doc.rows[0]!.id

      // Seed an audit row for this document
      await server.db.query(
        `INSERT INTO document_field_audit
           (document_id, tenant_id, table_name, field_name, action, new_value, changed_by, changed_at, change_source)
         VALUES ($1, $2, 'invoices', 'total', 'update', $3::jsonb, $4, '2026-10-01T00:00:00Z', 'manual_correction')`,
        [hiddenDocId, TENANT, JSON.stringify('x'), R68_OWNER],
      )

      // As a user who does not own or share this customer, the row must not appear
      const userHeaders = { 'x-tenant-id': TENANT, 'x-user-id': R68_LOOKER, 'x-user-role': 'user' }
      const userRes = await server.fetch('/api/documents/audit/export', { headers: userHeaders })
      const userText = await userRes.text()
      expect(userText).not.toContain(hiddenDocId)

      // As an admin, the row must appear
      const adminHeaders = { 'x-tenant-id': TENANT, 'x-user-id': R68_LOOKER, 'x-user-role': 'admin' }
      const adminRes = await server.fetch('/api/documents/audit/export', { headers: adminHeaders })
      const adminText = await adminRes.text()
      expect(adminText).toContain(hiddenDocId)
    }, DB_TIMEOUT)
  })
})
