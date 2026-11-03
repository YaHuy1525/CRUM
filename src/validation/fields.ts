/** Columns a reviewer may correct. The audit trigger fires on each of these. */
export const INVOICE_FIELDS = [
  'vendor_name', 'vendor_email', 'invoice_number', 'invoice_date',
  'due_date', 'currency', 'subtotal', 'tax', 'total',
] as const

export const CONTRACT_FIELDS = [
  'counterparty', 'counterparty_email', 'effective_date', 'expiry_date',
  'term_months', 'contract_value', 'currency', 'auto_renewal', 'renewal_notice_days',
] as const

/** Qualified names for line findings, which display but do not correct in this phase. */
export const LINE_FIELDS = ['lines.amount'] as const

const CORRECTABLE = new Set<string>([...INVOICE_FIELDS, ...CONTRACT_FIELDS, ...LINE_FIELDS])

export function isCorrectable(field: string): boolean {
  return CORRECTABLE.has(field)
}
