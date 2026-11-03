import { describe, expect, it } from 'vitest'
import { buildBundle, evaluate, RULES } from '../../src/validation/index.js'
import type { ValidationContext } from '../../src/validation/types.js'

const CTX: ValidationContext = { today: '2026-11-03' }

const GOOD = {
  vendor_name: 'Acme Supplies',
  vendor_email: 'billing@acme.example',
  invoice_number: 'INV-2041',
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  currency: 'AUD',
  subtotal: '1000.00',
  tax: '100.00',
  total: '1100.00',
}

function check(overrides: Record<string, unknown>, lines: Array<Record<string, unknown>> = [{ description: 'x', quantity: '2', unit_price: '550', amount: '1100' }]) {
  return evaluate(buildBundle('invoice', { ...GOOD, ...overrides }, lines, []), CTX)
}

function ids(violations: ReturnType<typeof check>): string[] {
  return violations.map((x) => x.ruleId)
}

it('fires nothing at all on a compliant invoice', () => {
  expect(check({})).toEqual([])
})

describe('presence rules', () => {
  it.each([
    ['invoice_number', 'invoice.invoice_number.present'],
    ['vendor_name', 'invoice.vendor_name.present'],
    ['total', 'invoice.total.present'],
    ['invoice_date', 'invoice.invoice_date.present'],
  ])('names %s absent as an error on itself', (field, ruleId) => {
    expect(ids(check({ [field]: null }))).toContain(ruleId)
  })
  it('treats a blank string as absent', () => {
    expect(ids(check({ invoice_number: '   ' }))).toContain('invoice.invoice_number.present')
  })
  it('keeps a zero total rather than calling it absent', () => {
    expect(ids(check({ total: '0' }))).not.toContain('invoice.total.present')
  })
})

describe('currency', () => {
  it('warns on a code that is not three letters', () => {
    expect(ids(check({ currency: 'AU' }))).toContain('invoice.currency.shape')
  })
  it('stays silent on a lowercase three-letter code', () => {
    expect(ids(check({ currency: 'aud' }))).not.toContain('invoice.currency.shape')
  })
})

describe('amounts', () => {
  it('errors on a negative total', () => {
    const hits = check({ total: '-5' })
    expect(ids(hits)).toContain('invoice.total.nonnegative')
    expect(hits.find((h) => h.ruleId === 'invoice.total.nonnegative')?.severity).toBe('error')
  })
  it('warns on a total that has run away past a plausible ceiling', () => {
    expect(ids(check({ total: '100000000' }))).toContain('invoice.total.range')
    expect(ids(check({ total: '99999999' }))).not.toContain('invoice.total.range')
  })
  it('errors where subtotal plus tax is not the total', () => {
    const hits = check({ total: '1200.00' })
    const sum = hits.find((h) => h.ruleId === 'invoice.total.sum')
    expect(sum?.field).toBe('total')
    expect(sum?.severity).toBe('error')
    expect(sum?.details).toMatchObject({ subtotal: 1000, tax: 100, total: 1200 })
  })
  it('forgives one cent of rounding', () => {
    expect(ids(check({ total: '1100.01' }))).not.toContain('invoice.total.sum')
  })
  it('stays silent when a component is missing, because absence is not arithmetic', () => {
    expect(ids(check({ subtotal: null }))).not.toContain('invoice.total.sum')
  })
  it('stays silent when a component is unparseable', () => {
    expect(ids(check({ tax: 'GST' }))).not.toContain('invoice.total.sum')
  })
})

describe('dates', () => {
  it('warns on an invoice dated after today', () => {
    expect(ids(check({ invoice_date: '2026-11-04' }))).toContain('invoice.invoice_date.future')
    expect(ids(check({ invoice_date: '2026-11-03' }))).not.toContain('invoice.invoice_date.future')
  })
  it('errors on a due date before the invoice date', () => {
    expect(ids(check({ due_date: '2026-09-01' }))).toContain('invoice.due_date.order')
  })
  it('does not invent an order check when the due date is absent', () => {
    expect(ids(check({ due_date: null }))).not.toContain('invoice.due_date.order')
  })
  it('ignores an unparseable date instead of reporting it twice', () => {
    expect(ids(check({ invoice_date: '31 Oct 2026' }))).not.toContain('invoice.invoice_date.future')
  })
})

it('warns on a malformed vendor email but stays silent when absent', () => {
  expect(ids(check({ vendor_email: 'not-an-email' }))).toContain('invoice.vendor_email.format')
  expect(ids(check({ vendor_email: null }))).not.toContain('invoice.vendor_email.format')
})

describe('lines', () => {
  it('warns on a line whose quantity times unit price is not its amount', () => {
    const hits = check({}, [{ description: 'x', quantity: '2', unit_price: '500', amount: '1100' }])
    const line = hits.find((h) => h.ruleId === 'invoice.lines.amount')
    expect(line?.field).toBe('lines.amount')
    expect(line?.details?.line).toBe(0)
  })
  it('forgives one cent of rounding on a line', () => {
    expect(ids(check({}, [{ quantity: '3', unit_price: '3.33', amount: '9.99' }])))
      .not.toContain('invoice.lines.amount')
  })
  it('reports the first bad line and how many are bad, because one rule and one field store one row', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ quantity: '2', unit_price: '1', amount: String(50 + i) }))
    const hits = check({}, many).filter((h) => h.ruleId === 'invoice.lines.amount')
    expect(hits.length).toBe(1)
    expect(hits[0]!.details).toMatchObject({ line: 0, badLineCount: 9 })
  })
  it('warns when a total exists and no line was extracted', () => {
    expect(ids(check({}, []))).toContain('invoice.lines.present')
    expect(ids(check({ total: null }, []))).not.toContain('invoice.lines.present')
  })
})

it('pins the thirteen invoice rule ids', () => {
  expect(RULES.filter((r) => r.appliesTo === 'invoice').map((r) => r.id).sort()).toEqual([
    'invoice.currency.shape',
    'invoice.due_date.order',
    'invoice.invoice_date.future',
    'invoice.invoice_date.present',
    'invoice.invoice_number.present',
    'invoice.lines.amount',
    'invoice.lines.present',
    'invoice.total.nonnegative',
    'invoice.total.present',
    'invoice.total.range',
    'invoice.total.sum',
    'invoice.vendor_email.format',
    'invoice.vendor_name.present',
  ])
})
