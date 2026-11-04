import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Load .env before any module that reads process.env at import time.
const envPath = fileURLToPath(new URL('../../.env', import.meta.url))
if (existsSync(envPath)) {
  process.loadEnvFile(envPath)
}

import { afterAll, describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import { createTestServer } from '../helpers/test-server.js'
import { getDbClient } from '../../src/db/client.js'

const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''

const TENANT = '00000000-0000-4000-8000-000000000001'
const USER = '00000000-0000-4000-8000-000000000002'
const HEADERS = {
  'x-tenant-id': TENANT,
  'x-user-id': USER,
  'x-user-role': 'admin',
  'content-type': 'application/json',
}

const created: string[] = []

// A corrected PATCH carries ~20 sequential queries over the remote pooler inside one
// transaction, so these cases can exceed vitest's 5s default wherever the gate URL exists.
const DB_TIMEOUT = 30_000

async function seedInvoice(
  db: Pool,
  fields: { subtotal?: string; tax?: string; total?: string; currency?: string },
): Promise<string> {
  const docResult = await db.query<{ id: string }>(
    `INSERT INTO documents (tenant_id, owner_id, kind, title, source, content_hash, content_text, mime, status)
     VALUES ($1, $2, 'invoice', 'Correction Revalidates Invoice', 'upload', $3, 'Test content', 'text/plain', 'ready')
     RETURNING id`,
    [TENANT, USER, `hash-correction-revalidates-${crypto.randomUUID()}`],
  )
  const docId = docResult.rows[0]!.id
  created.push(docId)

  const client: PoolClient = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', USER])
    await client.query('SELECT set_config($1, $2, true)', ['app.change_source', 'extraction'])
    // invoice_number and invoice_date are fixed and valid on purpose: the correction
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

describe.skipIf(url === '')('a correction re-validates in its own transaction', () => {
  afterAll(async () => {
    if (created.length > 0) {
      await getDbClient().query(
        'DELETE FROM documents WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
        [TENANT, created],
      )
    }
  })

  it('clears the sum finding when the total is corrected, in the same response', async () => {
    const server = await createTestServer()
    const doc = await seedInvoice(server.db, { subtotal: '1000.00', tax: '100.00', total: '1200.00' })

    const first = await server.fetch('/api/documents/' + doc + '/validation', {
      method: 'POST', headers: HEADERS, body: '{}',
    })
    const before = (await first.json()) as { violations: Array<{ ruleId: string }> }
    expect(before.violations.map((v) => v.ruleId)).toContain('invoice.total.sum')

    const res = await server.fetch('/api/documents/' + doc + '/invoices/total', {
      method: 'PATCH', headers: HEADERS,
      body: JSON.stringify({ value: '1100.00', reason: 'the footer of the page carried the right total' }),
    })
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
    const server = await createTestServer()
    const doc = await seedInvoice(server.db, { subtotal: '1000.00', tax: '100.00', total: '1200.00' })
    const res = await server.fetch('/api/documents/' + doc + '/invoices/total', {
      method: 'PATCH', headers: HEADERS, body: JSON.stringify({ value: '1300.00' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { openErrors: number }
    expect(body.openErrors).toBeGreaterThan(0)
  }, DB_TIMEOUT)

  it('attributes both corrections on one pooled connection to their own actor', async () => {
    const server = await createTestServer()
    const docA = await seedInvoice(server.db, { total: '10.00' })
    const docB = await seedInvoice(server.db, { total: '20.00' })
    for (const [doc, value] of [[docA, '11.00'], [docB, '22.00']] as const) {
      await server.fetch('/api/documents/' + doc + '/invoices/total', {
        method: 'PATCH', headers: HEADERS, body: JSON.stringify({ value }),
      })
    }
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
