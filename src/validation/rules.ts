import {
  AMOUNT_TOLERANCE,
  MAX_PLAUSIBLE_AMOUNT,
  isAbsent,
  isCurrencyShape,
  isEmail,
  parseAmount,
  parseDate,
} from './values.js'
import type { DocumentRecordBundle, ValidationRule, Violation } from './types.js'

type Row = Record<string, unknown>

function make(
  ruleId: string,
  field: string,
  severity: Violation['severity'],
  message: string,
  details?: Record<string, string | number>,
): Violation {
  return details ? { ruleId, field, severity, message, details } : { ruleId, field, severity, message }
}

function header(bundle: DocumentRecordBundle): Row {
  return bundle.invoice ?? bundle.contract ?? {}
}

function present(row: Row, field: string): boolean {
  return !isAbsent(row[field])
}

/**
 * One rule and one field store one row, so the line rule reports the first bad line
 * and counts the rest. A reviewer sees that the table is wrong and that it is not
 * just one line, which is the whole job of the finding.
 */
function lineAmountFailure(lines: Row[]): { index: number; badCount: number } | null {
  let first = -1
  let badCount = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as Row
    const qty = parseAmount(line.quantity)
    const price = parseAmount(line.unit_price)
    const amount = parseAmount(line.amount)
    if (qty === null || price === null || amount === null) continue
    if (Math.abs(qty * price - amount) <= AMOUNT_TOLERANCE) continue
    badCount += 1
    if (first === -1) first = i
  }
  return first === -1 ? null : { index: first, badCount }
}

export const RULES: ValidationRule[] = [
  {
    id: 'invoice.vendor_name.present', appliesTo: 'invoice', fields: ['vendor_name'],
    run: (b) => present(header(b), 'vendor_name') ? []
      : [make('invoice.vendor_name.present', 'vendor_name', 'error', 'No vendor name was extracted.')],
  },
  {
    id: 'invoice.invoice_number.present', appliesTo: 'invoice', fields: ['invoice_number'],
    run: (b) => present(header(b), 'invoice_number') ? []
      : [make('invoice.invoice_number.present', 'invoice_number', 'error', 'No invoice number was extracted.')],
  },
  {
    id: 'invoice.invoice_date.present', appliesTo: 'invoice', fields: ['invoice_date'],
    run: (b) => present(header(b), 'invoice_date') ? []
      : [make('invoice.invoice_date.present', 'invoice_date', 'error', 'No invoice date was extracted.')],
  },
  {
    id: 'invoice.total.present', appliesTo: 'invoice', fields: ['total'],
    run: (b) => present(header(b), 'total') ? []
      : [make('invoice.total.present', 'total', 'error', 'No total amount was extracted.')],
  },
  {
    id: 'invoice.currency.shape', appliesTo: 'invoice', fields: ['currency'],
    run: (b) => {
      const h = header(b)
      if (!present(h, 'currency') || isCurrencyShape(h.currency)) return []
      return [make('invoice.currency.shape', 'currency', 'warning',
        'Currency is not a three-letter code.', { currency: String(h.currency) })]
    },
  },
  {
    id: 'invoice.total.nonnegative', appliesTo: 'invoice', fields: ['total'],
    run: (b) => {
      const n = parseAmount(header(b).total)
      return n !== null && n < 0
        ? [make('invoice.total.nonnegative', 'total', 'error', 'Total is negative.', { total: n })]
        : []
    },
  },
  {
    id: 'invoice.total.range', appliesTo: 'invoice', fields: ['total'],
    run: (b) => {
      const n = parseAmount(header(b).total)
      return n !== null && n >= MAX_PLAUSIBLE_AMOUNT
        ? [make('invoice.total.range', 'total', 'warning',
            'Total is at or above ' + MAX_PLAUSIBLE_AMOUNT + ', which usually means digits ran together.', { total: n })]
        : []
    },
  },
  {
    id: 'invoice.total.sum', appliesTo: 'invoice', fields: ['total'],
    run: (b) => {
      const h = header(b)
      const subtotal = parseAmount(h.subtotal)
      const tax = parseAmount(h.tax)
      const total = parseAmount(h.total)
      if (subtotal === null || tax === null || total === null) return []
      const expected = subtotal + tax
      if (Math.abs(expected - total) <= AMOUNT_TOLERANCE) return []
      return [make('invoice.total.sum', 'total', 'error',
        'Subtotal plus tax is ' + expected.toFixed(2) + ' but the total reads ' + total.toFixed(2) + '.',
        { subtotal, tax, total, expected })]
    },
  },
  {
    id: 'invoice.invoice_date.future', appliesTo: 'invoice', fields: ['invoice_date'],
    run: (b, ctx) => {
      const d = parseDate(header(b).invoice_date)
      return d !== null && d > ctx.today
        ? [make('invoice.invoice_date.future', 'invoice_date', 'warning',
            'Invoice date is after today.', { invoice_date: d, today: ctx.today })]
        : []
    },
  },
  {
    id: 'invoice.due_date.order', appliesTo: 'invoice', fields: ['due_date'],
    run: (b) => {
      const h = header(b)
      const issued = parseDate(h.invoice_date)
      const due = parseDate(h.due_date)
      if (issued === null || due === null) return []
      return due < issued
        ? [make('invoice.due_date.order', 'due_date', 'error',
            'Due date precedes the invoice date.', { invoice_date: issued, due_date: due })]
        : []
    },
  },
  {
    id: 'invoice.vendor_email.format', appliesTo: 'invoice', fields: ['vendor_email'],
    run: (b) => {
      const h = header(b)
      if (!present(h, 'vendor_email') || isEmail(h.vendor_email)) return []
      return [make('invoice.vendor_email.format', 'vendor_email', 'warning',
        'Vendor email is not a valid address.', { vendor_email: String(h.vendor_email) })]
    },
  },
  {
    id: 'invoice.lines.amount', appliesTo: 'invoice', fields: ['lines.amount'],
    run: (b) => {
      const bad = lineAmountFailure(b.lines)
      if (bad === null) return []
      const line = b.lines[bad.index] as Row
      return [make('invoice.lines.amount', 'lines.amount', 'warning',
        'Line ' + (bad.index + 1) + ' is ' + String(line.quantity) + ' at ' + String(line.unit_price)
          + ' but reads ' + String(line.amount) + '.',
        { line: bad.index, badLineCount: bad.badCount })]
    },
  },
  {
    id: 'invoice.lines.present', appliesTo: 'invoice', fields: ['lines.amount'],
    run: (b) => (present(header(b), 'total') && b.lines.length === 0)
      ? [make('invoice.lines.present', 'lines.amount', 'warning',
          'A total was extracted but no line item was.')]
      : [],
  },
]
