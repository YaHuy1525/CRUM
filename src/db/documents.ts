import { getDbClient } from './client'
import type { TenantRequestContext } from '../mastra/tenant-context'


export interface DocumentRow {
  id: string
  tenant_id: string
  owner_id: string
  kind: 'invoice' | 'contract' | 'other'
  title: string
  source: 'upload' | 'email'
  source_ref: string | null
  content_hash: string
  mime: string
  status: 'pending' | 'processing' | 'ready' | 'needs_review' | 'failed'
  confidence: string | null
  customer_id: string | null
  created_at: string
  updated_at: string
}

export interface InvoiceRow {
  document_id: string
  vendor_name: string | null
  vendor_email: string | null
  invoice_number: string | null
  invoice_date: string | null
  due_date: string | null
  currency: string | null
  subtotal: string | null
  tax: string | null
  total: string | null
}

export interface InvoiceLineRow {
  id: string
  document_id: string
  description: string | null
  quantity: string | null
  unit_price: string | null
  amount: string | null
  currency: string | null
}

export interface ContractRow {
  document_id: string
  counterparty: string | null
  counterparty_email: string | null
  effective_date: string | null
  expiry_date: string | null
  term_months: number | null
  contract_value: string | null
  currency: string | null
  auto_renewal: boolean | null
  renewal_notice_days: number | null
}

export interface ContractTermRow {
  id: string
  document_id: string
  clause_type: string | null
  title: string | null
  text: string | null
  start_offset: number | null
  end_offset: number | null
}

export type NullableNumber = number | string | null

export interface InvoiceHeaderWrite {
  vendor_name: string | null
  vendor_email: string | null
  invoice_number: string | null
  invoice_date: string | null
  due_date: string | null
  currency: string | null
  subtotal: NullableNumber
  tax: NullableNumber
  total: NullableNumber
}

export interface InvoiceLineWrite {
  description: string | null
  quantity: NullableNumber
  unit_price: NullableNumber
  amount: NullableNumber
  currency: string | null
}

export interface ContractHeaderWrite {
  counterparty: string | null
  counterparty_email: string | null
  effective_date: string | null
  expiry_date: string | null
  term_months: number | null
  contract_value: NullableNumber
  currency: string | null
  auto_renewal: boolean | null
  renewal_notice_days: number | null
}

export interface ContractTermWrite {
  clause_type: string | null
  title: string | null
  text: string | null
  start_offset: number | null
  end_offset: number | null
}

function docVisibility(context: TenantRequestContext): { sql: string; params: unknown[] } {
  if (context.userRole === 'admin') {
    return { sql: 'd.tenant_id = $1', params: [context.tenantId] }
  }
  return {
    sql: `d.tenant_id = $1 AND (
            d.owner_id = $2
            OR d.customer_id IS NULL
            OR d.customer_id IN (
              SELECT id FROM customers
               WHERE tenant_id = $1 AND deleted_at IS NULL
                 AND (owner_id = $2 OR $2 = ANY(team_member_ids))
            )
          )`,
    params: [context.tenantId, context.userId],
  }
}

async function queryRows<T>(sql: string, params: unknown[]): Promise<T[]> {
  const result = await getDbClient().query(sql, params)
  return result.rows as T[]
}

export interface PersistDocumentInput {
  tenantId: string
  ownerId: string
  kind: 'invoice' | 'contract' | 'other'
  title: string
  source: 'upload' | 'email'
  sourceRef: string | null
  contentHash: string
  contentText: string
  mime: string
  status: 'ready' | 'needs_review'
  confidence: number | null
  customerId: string | null
  rawExtract: unknown
  invoice?: InvoiceHeaderWrite | null
  invoiceLines?: InvoiceLineWrite[]
  contract?: ContractHeaderWrite | null
  contractTerms?: ContractTermWrite[]
}

export async function insertDocument(
  input: PersistDocumentInput,
): Promise<{ id: string; status: string; confidence: number | null }> {
  const db = getDbClient()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const docResult = await client.query<{ id: string; status: string; confidence: string | null }>(
      `INSERT INTO documents
         (tenant_id, owner_id, kind, title, source, source_ref, content_hash, content_text,
          mime, status, confidence, customer_id, raw_extract)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
       ON CONFLICT (tenant_id, content_hash) DO UPDATE SET updated_at = now()
       RETURNING id, status, confidence`,
      [
        input.tenantId,
        input.ownerId,
        input.kind,
        input.title,
        input.source,
        input.sourceRef,
        input.contentHash,
        input.contentText,
        input.mime,
        input.status,
        input.confidence,
        input.customerId,
        JSON.stringify(input.rawExtract ?? {}),
      ],
    )
    const row = docResult.rows[0]
    if (!row) throw new Error('document insert returned no row')

    if (input.kind === 'invoice' && input.invoice) {
      await client.query(
        `INSERT INTO invoices
           (document_id, vendor_name, vendor_email, invoice_number, invoice_date, due_date,
            currency, subtotal, tax, total)
         VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $9, $10)
         ON CONFLICT (document_id) DO NOTHING`,
        [
          row.id,
          input.invoice.vendor_name,
          input.invoice.vendor_email,
          input.invoice.invoice_number,
          input.invoice.invoice_date,
          input.invoice.due_date,
          input.invoice.currency,
          input.invoice.subtotal,
          input.invoice.tax,
          input.invoice.total,
        ],
      )
      for (const line of input.invoiceLines ?? []) {
        await client.query(
          `INSERT INTO invoice_lines (document_id, description, quantity, unit_price, amount, currency)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [row.id, line.description, line.quantity, line.unit_price, line.amount, line.currency],
        )
      }
    }

    if (input.kind === 'contract' && input.contract) {
      await client.query(
        `INSERT INTO contracts
           (document_id, counterparty, counterparty_email, effective_date, expiry_date,
            term_months, contract_value, currency, auto_renewal, renewal_notice_days)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, $10)
         ON CONFLICT (document_id) DO NOTHING`,
        [
          row.id,
          input.contract.counterparty,
          input.contract.counterparty_email,
          input.contract.effective_date,
          input.contract.expiry_date,
          input.contract.term_months,
          input.contract.contract_value,
          input.contract.currency,
          input.contract.auto_renewal,
          input.contract.renewal_notice_days,
        ],
      )
      for (const term of input.contractTerms ?? []) {
        await client.query(
          `INSERT INTO contract_terms (document_id, clause_type, title, text, start_offset, end_offset)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [row.id, term.clause_type, term.title, term.text, term.start_offset, term.end_offset],
        )
      }
    }

    await client.query('COMMIT')
    return {
      id: row.id,
      status: row.status,
      confidence: row.confidence === null ? null : Number(row.confidence),
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function markDocumentFailed(id: string, tenantId: string): Promise<void> {
  await getDbClient().query(
    `UPDATE documents SET status = 'failed', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  )
}

export async function listDocuments(
  context: TenantRequestContext,
  filters: { kind?: string; customerId?: string; status?: string } = {},
  limit = 50,
): Promise<DocumentRow[]> {
  const vis = docVisibility(context)
  const conditions = [vis.sql]
  const params: unknown[] = [...vis.params]
  let idx = params.length

  if (filters.kind) {
    idx++
    conditions.push(`d.kind = $${idx}`)
    params.push(filters.kind)
  }
  if (filters.status) {
    idx++
    conditions.push(`d.status = $${idx}`)
    params.push(filters.status)
  }
  if (filters.customerId) {
    idx++
    conditions.push(`d.customer_id = $${idx}`)
    params.push(filters.customerId)
  }

  idx++
  params.push(limit)

  return queryRows<DocumentRow>(
    `SELECT d.id, d.tenant_id, d.owner_id, d.kind, d.title, d.source, d.source_ref, d.content_hash,
            d.mime, d.status, d.confidence, d.customer_id, d.created_at, d.updated_at
       FROM documents d
      WHERE ${conditions.join(' AND ')}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT $${idx}`,
    params,
  )
}

export async function getDocument(
  context: TenantRequestContext,
  id: string,
): Promise<DocumentRow | null> {
  const vis = docVisibility(context)
  const params = [...vis.params, id]
  const rows = await queryRows<DocumentRow>(
    `SELECT d.id, d.tenant_id, d.owner_id, d.kind, d.title, d.source, d.source_ref, d.content_hash,
            d.mime, d.status, d.confidence, d.customer_id, d.created_at, d.updated_at
       FROM documents d
      WHERE d.id = $${params.length} AND ${vis.sql}
      LIMIT 1`,
    params,
  )
  return rows[0] ?? null
}

export async function getInvoice(
  context: TenantRequestContext,
  documentId: string,
): Promise<{ header: InvoiceRow | null; lines: InvoiceLineRow[] }> {
  const doc = await getDocument(context, documentId)
  if (!doc) return { header: null, lines: [] }
  const [header, lines] = await Promise.all([
    queryRows<InvoiceRow>(`SELECT * FROM invoices WHERE document_id = $1 LIMIT 1`, [documentId]),
    queryRows<InvoiceLineRow>(
      `SELECT * FROM invoice_lines WHERE document_id = $1 ORDER BY id ASC`,
      [documentId],
    ),
  ])
  return { header: header[0] ?? null, lines }
}

export async function getContract(
  context: TenantRequestContext,
  documentId: string,
): Promise<{ header: ContractRow | null; terms: ContractTermRow[] }> {
  const doc = await getDocument(context, documentId)
  if (!doc) return { header: null, terms: [] }
  const [header, terms] = await Promise.all([
    queryRows<ContractRow>(`SELECT * FROM contracts WHERE document_id = $1 LIMIT 1`, [documentId]),
    queryRows<ContractTermRow>(
      `SELECT * FROM contract_terms WHERE document_id = $1 ORDER BY start_offset ASC NULLS LAST, id ASC`,
      [documentId],
    ),
  ])
  return { header: header[0] ?? null, terms }
}

export async function sumInvoices(
  context: TenantRequestContext,
  filters: { customerId?: string; from?: string; to?: string } = {},
): Promise<{ vendor_name: string | null; invoice_count: number; total: string | null; currency: string | null }[]> {
  const vis = docVisibility(context)
  const conditions = [vis.sql, `d.kind = 'invoice'`, `d.status = 'ready'`]
  const params: unknown[] = [...vis.params]
  let idx = params.length

  if (filters.customerId) {
    idx++
    conditions.push(`d.customer_id = $${idx}`)
    params.push(filters.customerId)
  }
  if (filters.from) {
    idx++
    conditions.push(`i.invoice_date >= $${idx}::date`)
    params.push(filters.from)
  }
  if (filters.to) {
    idx++
    conditions.push(`i.invoice_date <= $${idx}::date`)
    params.push(filters.to)
  }

  return queryRows<{
    vendor_name: string | null
    invoice_count: number
    total: string | null
    currency: string | null
  }>(
    `SELECT i.vendor_name,
            count(*)::int AS invoice_count,
            sum(i.total)::text AS total,
            min(i.currency) AS currency
       FROM documents d
       JOIN invoices i ON i.document_id = d.id
      WHERE ${conditions.join(' AND ')}
      GROUP BY i.vendor_name
      ORDER BY sum(i.total) DESC NULLS LAST, i.vendor_name ASC`,
    params,
  )
}

export async function resolveCustomerByEntity(
  tenantId: string,
  entity: { email?: string | null; name?: string | null },
): Promise<string | null> {
  const db = getDbClient()
  if (entity.email) {
    const byEmail = await db.query<{ id: string }>(
      `SELECT id FROM customers
        WHERE tenant_id = $1 AND deleted_at IS NULL AND lower(email) = lower($2)
        LIMIT 2`,
      [tenantId, entity.email],
    )
    if (byEmail.rows.length === 1) return byEmail.rows[0]!.id
    if (byEmail.rows.length > 1) return null
  }
  if (entity.name) {
    const byName = await db.query<{ id: string }>(
      `SELECT id FROM customers
        WHERE tenant_id = $1 AND deleted_at IS NULL AND lower(btrim(company)) = lower(btrim($2))
        LIMIT 2`,
      [tenantId, entity.name],
    )
    if (byName.rows.length === 1) return byName.rows[0]!.id
  }
  return null
}

export async function reviewDocument(
  context: TenantRequestContext,
  id: string,
): Promise<{ id: string; status: string } | null> {
  const vis = docVisibility(context)
  const params = [...vis.params, id]
  const rows = await queryRows<{ id: string; status: string }>(
    `UPDATE documents AS d SET status = 'ready', updated_at = now()
      WHERE d.id = $${params.length} AND ${vis.sql} AND d.status = 'needs_review'
      RETURNING d.id, d.status`,
    params,
  )
  return rows[0] ?? null
}
