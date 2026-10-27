import { z } from 'zod'


const money = z.string().min(1)
const dateStr = z.string().min(1)

export const invoiceLineSchema = z.object({
  description: z.string().optional(),
  quantity: z.string().optional(),
  unitPrice: z.string().optional(),
  amount: z.string().optional(),
  currency: z.string().optional(),
})

export const invoiceSchema = z.object({
  vendorName: z.string().optional(),
  vendorEmail: z.string().optional(),
  invoiceNumber: z.string().optional(),
  invoiceDate: dateStr.optional(),
  dueDate: dateStr.optional(),
  currency: z.string().optional(),
  subtotal: money.optional(),
  tax: money.optional(),
  total: money.optional(),
  lines: z.array(invoiceLineSchema).optional(),
  confidence: z.number().min(0).max(1).optional(),
})

export const contractTermSchema = z.object({
  clauseType: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
})

export const contractSchema = z.object({
  counterparty: z.string().optional(),
  counterpartyEmail: z.string().optional(),
  effectiveDate: dateStr.optional(),
  expiryDate: dateStr.optional(),
  termMonths: z.string().optional(),
  contractValue: money.optional(),
  currency: z.string().optional(),
  autoRenewal: z.boolean().optional(),
  renewalNoticeDays: z.string().optional(),
  terms: z.array(contractTermSchema).optional(),
  confidence: z.number().min(0).max(1).optional(),
})

export const documentKindSchema = z.enum(['invoice', 'contract', 'other'])

export type DocumentKind = z.infer<typeof documentKindSchema>
export type InvoiceExtract = z.infer<typeof invoiceSchema>
export type ContractExtract = z.infer<typeof contractSchema>
export type InvoiceLineExtract = z.infer<typeof invoiceLineSchema>
export type ContractTermExtract = z.infer<typeof contractTermSchema>

export const EXTRACT_SCHEMAS = {
  invoice: invoiceSchema,
  contract: contractSchema,
} as const

export type ExtractKind = keyof typeof EXTRACT_SCHEMAS
