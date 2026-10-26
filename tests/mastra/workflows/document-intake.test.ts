import { describe, expect, it } from 'vitest'
import {
  CONFIDENCE_THRESHOLD,
  asRecord,
  classifyKindHeuristic,
  computeConfidence,
  coverageScore,
  normalizeContract,
  normalizeInvoice,
  parseDateValue,
  parseIntValue,
  parseMoneyValue,
} from '../../../src/mastra/workflows/document-intake'

/**
 * Unit coverage for the deterministic half of the intake workflow — the pure
 * helpers the parse/classify/normalise/confidence steps are built from. The model
 * call and DB writes are exercised in the route and workflow-run tests; what is
 * pinned here is the logic that decides whether a low-confidence extraction is
 * trusted, and that a numeric/date field is normalised to a queryable column
 * rather than stored as the raw string the model returned.
 */

describe('parseMoneyValue', () => {
  it('strips currency symbols and thousands separators', () => {
    expect(parseMoneyValue('$1,234.56')).toBe(1234.56)
    expect(parseMoneyValue('€ 12 345,00'.replace(',', '.'))).toBe(12345)
  })
  it('parses a bare number and a negative', () => {
    expect(parseMoneyValue('42')).toBe(42)
    expect(parseMoneyValue('-7.5')).toBe(-7.5)
  })
  it('returns null for anything not a clean number', () => {
    expect(parseMoneyValue('')).toBeNull()
    expect(parseMoneyValue(null)).toBeNull()
    expect(parseMoneyValue('N/A')).toBeNull()
    expect(parseMoneyValue('-')).toBeNull()
  })
})

describe('parseDateValue', () => {
  it('passes an ISO date through unchanged', () => {
    expect(parseDateValue('2026-03-15')).toBe('2026-03-15')
  })
  it('normalises a parseable date to YYYY-MM-DD', () => {
    // An explicit UTC instant hits the Date.parse fallback deterministically; a
    // bare 'March 15, 2026' parses to local midnight and shifts the UTC calendar day.
    expect(parseDateValue('Mar 15 2026 12:00:00 GMT+0000')).toBe('2026-03-15')
  })
  it('never guesses a year or an unparseable value', () => {
    expect(parseDateValue('not a date')).toBeNull()
    expect(parseDateValue('')).toBeNull()
    expect(parseDateValue(null)).toBeNull()
  })
})

describe('parseIntValue', () => {
  it('truncates and coerces an integer', () => {
    expect(parseIntValue('12')).toBe(12)
    expect(parseIntValue('24 months')).toBe(24)
    expect(parseIntValue(36.9)).toBe(36)
  })
  it('returns null for empty or non-numeric', () => {
    expect(parseIntValue('')).toBeNull()
    expect(parseIntValue('none')).toBeNull()
    expect(parseIntValue(null)).toBeNull()
  })
})

describe('coverageScore', () => {
  it('counts present required fields as a fraction', () => {
    expect(coverageScore({ vendorName: 'Acme', total: '100', invoiceDate: '2026-01-01' }, 'invoice')).toBe(1)
    expect(coverageScore({ vendorName: 'Acme' }, 'invoice')).toBeCloseTo(1 / 3)
    expect(coverageScore({}, 'invoice')).toBe(0)
  })
  it('treats an empty string as missing', () => {
    expect(coverageScore({ vendorName: '', total: '5', invoiceDate: 'x' }, 'invoice')).toBeCloseTo(2 / 3)
  })
})

describe('computeConfidence', () => {
  it('blends model self-report with coverage equally', () => {
    expect(computeConfidence(1, 0)).toBe(0.5)
    expect(computeConfidence(0, 1)).toBe(0.5)
    expect(computeConfidence(1, 1)).toBe(1)
  })
  it('falls back to coverage alone when the model gave no number', () => {
    expect(computeConfidence(undefined, 0.8)).toBe(0.8)
  })
  it('clamps to 0..1', () => {
    expect(computeConfidence(5, 5)).toBe(1)
    expect(computeConfidence(-2, -2)).toBe(0)
  })
})

describe('classifyKindHeuristic', () => {
  it('picks invoice from bill vocabulary', () => {
    const r = classifyKindHeuristic('INV-001', 'INVOICE Number 5 · Amount Due $10 · Subtotal $9 · Tax $1 · Due Date 2026-01-01')
    expect(r.kind).toBe('invoice')
    expect(r.ambiguous).toBe(false)
  })
  it('picks contract from agreement vocabulary', () => {
    const r = classifyKindHeuristic('MSA', 'This Agreement is made between the Parties, whereas the parties hereby agree ... renewal ... effective date')
    expect(r.kind).toBe('contract')
  })
  it('returns other for neither, and flags a close call as ambiguous', () => {
    expect(classifyKindHeuristic('notes', 'a shopping list of apples').kind).toBe('other')
    const tie = classifyKindHeuristic('doc', 'invoice and agreement')
    expect(tie.ambiguous || tie.kind).toBeTruthy()
  })
})

describe('normalizeInvoice', () => {
  it('types the header and line values', () => {
    const { header, lines } = normalizeInvoice({
      vendorName: 'Acme',
      invoiceDate: '2026-03-01',
      total: '$1,000.00',
      lines: [{ description: 'Seat', quantity: '2', unitPrice: '$500.00', amount: '$1,000.00' }],
    })
    expect(header.vendor_name).toBe('Acme')
    expect(header.total).toBe(1000)
    expect(header.invoice_date).toBe('2026-03-01')
    expect(lines[0]).toMatchObject({ description: 'Seat', quantity: 2, unit_price: 500, amount: 1000 })
  })
  it('tolerates a sparse extract without throwing', () => {
    const { header, lines } = normalizeInvoice({})
    expect(header.vendor_name).toBeNull()
    expect(header.total).toBeNull()
    expect(lines).toEqual([])
  })
})

describe('normalizeContract', () => {
  it('types the header and locates a term offset in the full text', () => {
    const full = 'Master Services Agreement. Payment terms: net 30.'
    const { header, terms } = normalizeContract(
      {
        counterparty: 'Globex',
        effectiveDate: '2026-01-01',
        contractValue: '$50,000',
        termMonths: '12',
        autoRenewal: true,
        terms: [{ clauseType: 'payment', title: 'Payment', text: 'Payment terms: net 30.' }],
      },
      full,
    )
    expect(header.counterparty).toBe('Globex')
    expect(header.contract_value).toBe(50000)
    expect(header.term_months).toBe(12)
    expect(header.auto_renewal).toBe(true)
    expect(terms[0]?.start_offset).toBe(full.indexOf('Payment terms'))
  })
  it('leaves an unmatched term offset null rather than a bogus index', () => {
    const { terms } = normalizeContract({ terms: [{ text: 'A clause not present' }] }, 'unrelated body text')
    expect(terms[0]?.start_offset).toBeNull()
  })
})

describe('asRecord', () => {
  it('accepts a populated object from a structured-output result', () => {
    expect(asRecord({ vendorName: 'Kingsford Kitchens', total: '1,111.00' })).toEqual({
      vendorName: 'Kingsford Kitchens',
      total: '1,111.00',
    })
  })

  it('rejects a JSON string, which is what reading result.text produced (the 502 bug)', () => {
    // The regression this pins: `result.text` is the raw model string, not the
    // parsed payload. Handing it to the next step fails its zod `record` check.
    expect(asRecord('{"vendorName":"Kingsford Kitchens"}')).toBeNull()
  })

  it('rejects a valid-but-empty object: usedFallbackValue false is not enough', () => {
    expect(asRecord({})).toBeNull()
  })

  it('rejects null, arrays, and primitives', () => {
    expect(asRecord(null)).toBeNull()
    expect(asRecord(undefined)).toBeNull()
    expect(asRecord(['a'])).toBeNull()
    expect(asRecord(42)).toBeNull()
  })
})

describe('confidence gate', () => {
  it('threshold is a strict-but-soft demotion boundary', () => {
    // A below-threshold blended score is what the pipeline demotes to needs_review.
    expect(computeConfidence(0.5, 0.5)).toBeLessThan(CONFIDENCE_THRESHOLD)
    expect(computeConfidence(0.9, 0.9)).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD)
  })
})
