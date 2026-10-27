import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { TenantRequestContextSchema } from '../tenant-context'
import {
  listDocuments,
  getDocument,
  getInvoice,
  getContract,
  sumInvoices,
} from '../../db/documents'


const nullableString = z.string().nullable()
const money = z.string().nullable()

const DocumentSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(['invoice', 'contract', 'other']),
  title: z.string(),
  status: z.enum(['pending', 'processing', 'ready', 'needs_review', 'failed']),
  confidence: money,
  customer_id: nullableString,
  created_at: z.string(),
  updated_at: z.string(),
})

const InvoiceSchema = z.object({
  vendor_name: nullableString,
  vendor_email: nullableString,
  invoice_number: nullableString,
  invoice_date: nullableString,
  due_date: nullableString,
  currency: nullableString,
  subtotal: money,
  tax: money,
  total: money,
})

const InvoiceLineSchema = z.object({
  description: nullableString,
  quantity: money,
  unit_price: money,
  amount: money,
  currency: nullableString,
})

const ContractSchema = z.object({
  counterparty: nullableString,
  counterparty_email: nullableString,
  effective_date: nullableString,
  expiry_date: nullableString,
  term_months: z.number().nullable(),
  contract_value: money,
  currency: nullableString,
  auto_renewal: z.boolean().nullable(),
  renewal_notice_days: z.number().nullable(),
})

const ContractTermSchema = z.object({
  clause_type: nullableString,
  title: nullableString,
  text: nullableString,
  start_offset: z.number().nullable(),
  end_offset: z.number().nullable(),
})

export const listDocumentsTool = createTool({
  id: 'doc.list_documents',
  title: 'List Documents',
  description:
    'List a tenant’s structured business documents (invoices and contracts). Filter by kind, ' +
    'linked customer, or status. Returns summaries, not bodies. Use it to find document ids for ' +
    'doc.get_invoice / doc.get_contract, or to see what still needs review.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    kind: z.enum(['invoice', 'contract', 'other']).optional(),
    customerId: z.string().uuid().optional(),
    status: z.enum(['ready', 'needs_review']).optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  outputSchema: z.array(DocumentSummarySchema),
  execute: async (input, context) => {
    return context.observe.span('doc.list_documents', async () => {
      const rc = context.requestContext.all
      const rows = await listDocuments(rc, {
        kind: input.kind,
        customerId: input.customerId,
        status: input.status,
      }, input.limit ?? 50)
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        status: r.status,
        confidence: r.confidence,
        customer_id: r.customer_id,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }))
    })
  },
})

export const getInvoiceTool = createTool({
  id: 'doc.get_invoice',
  title: 'Get Invoice',
  description:
    'Read one invoice by document id: the header (vendor, number, dates, subtotal/tax/total) ' +
    'and its line items. Returns null when the id is not a visible invoice.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({ documentId: z.string().uuid() }),
  outputSchema: z.object({
    document: DocumentSummarySchema.nullable(),
    invoice: InvoiceSchema.nullable(),
    lines: z.array(InvoiceLineSchema),
  }),
  execute: async (input, context) => {
    return context.observe.span('doc.get_invoice', async () => {
      const rc = context.requestContext.all
      const doc = await getDocument(rc, input.documentId)
      if (!doc || doc.kind !== 'invoice') {
        return { document: null, invoice: null, lines: [] }
      }
      const { header, lines } = await getInvoice(rc, input.documentId)
      return {
        document: {
          id: doc.id,
          kind: doc.kind,
          title: doc.title,
          status: doc.status,
          confidence: doc.confidence,
          customer_id: doc.customer_id,
          created_at: doc.created_at,
          updated_at: doc.updated_at,
        },
        invoice: header
          ? {
              vendor_name: header.vendor_name,
              vendor_email: header.vendor_email,
              invoice_number: header.invoice_number,
              invoice_date: header.invoice_date,
              due_date: header.due_date,
              currency: header.currency,
              subtotal: header.subtotal,
              tax: header.tax,
              total: header.total,
            }
          : null,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unit_price: l.unit_price,
          amount: l.amount,
          currency: l.currency,
        })),
      }
    })
  },
})

export const getContractTool = createTool({
  id: 'doc.get_contract',
  title: 'Get Contract',
  description:
    'Read one contract by document id: the header (counterparty, effective/expiry dates, term, ' +
    'value, renewal) and its extracted key terms. Returns null when the id is not a visible contract.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({ documentId: z.string().uuid() }),
  outputSchema: z.object({
    document: DocumentSummarySchema.nullable(),
    contract: ContractSchema.nullable(),
    terms: z.array(ContractTermSchema),
  }),
  execute: async (input, context) => {
    return context.observe.span('doc.get_contract', async () => {
      const rc = context.requestContext.all
      const doc = await getDocument(rc, input.documentId)
      if (!doc || doc.kind !== 'contract') {
        return { document: null, contract: null, terms: [] }
      }
      const { header, terms } = await getContract(rc, input.documentId)
      return {
        document: {
          id: doc.id,
          kind: doc.kind,
          title: doc.title,
          status: doc.status,
          confidence: doc.confidence,
          customer_id: doc.customer_id,
          created_at: doc.created_at,
          updated_at: doc.updated_at,
        },
        contract: header
          ? {
              counterparty: header.counterparty,
              counterparty_email: header.counterparty_email,
              effective_date: header.effective_date,
              expiry_date: header.expiry_date,
              term_months: header.term_months,
              contract_value: header.contract_value,
              currency: header.currency,
              auto_renewal: header.auto_renewal,
              renewal_notice_days: header.renewal_notice_days,
            }
          : null,
        terms: terms.map((t) => ({
          clause_type: t.clause_type,
          title: t.title,
          text: t.text,
          start_offset: t.start_offset,
          end_offset: t.end_offset,
        })),
      }
    })
  },
})

export const sumInvoicesTool = createTool({
  id: 'doc.sum_invoices',
  title: 'Sum Invoices',
  description:
    'Aggregate ready invoice totals by vendor, optionally scoped to a customer and a date range ' +
    '(YYYY-MM-DD). Answers spend questions the retriever cannot: who, how much, how many.',
  requestContextSchema: TenantRequestContextSchema,
  inputSchema: z.object({
    customerId: z.string().uuid().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
  }),
  outputSchema: z.array(
    z.object({
      vendor_name: nullableString,
      invoice_count: z.number(),
      total: money,
      currency: nullableString,
    }),
  ),
  execute: async (input, context) => {
    return context.observe.span('doc.sum_invoices', async () => {
      const rc = context.requestContext.all
      return sumInvoices(rc, { customerId: input.customerId, from: input.from, to: input.to })
    })
  },
})
