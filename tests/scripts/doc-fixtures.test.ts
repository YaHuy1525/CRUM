import { describe, expect, it } from 'vitest'
import { buildFixturePlan, buildManifestCsv } from '../../scripts/doc-fixtures'
import { generateTenantRows } from '../../scripts/sim-seed'

const plan = buildFixturePlan()
const simCustomers = generateTenantRows(0, { customers: 30 }).customers
const simIds = new Set(simCustomers.map((c) => c.id))

describe('fixture plan shape', () => {
  it('produces 30 files with unique, extension-consistent names', () => {
    expect(plan).toHaveLength(30)
    expect(new Set(plan.map((p) => p.file)).size).toBe(30)
    for (const p of plan) expect(p.file.endsWith(`.${p.format}`)).toBe(true)
  })

  it('exercises every expected status and every kind', () => {
    const statuses = new Set(plan.map((p) => p.expectedStatus))
    expect(statuses).toEqual(new Set(['ready', 'needs_review', 'failed']))
    const kinds = new Set(plan.map((p) => p.kind))
    expect(kinds).toEqual(new Set(['invoice', 'contract', 'other']))
  })

  it('includes both pdf and docx renderings for invoices and contracts', () => {
    const combos = new Set(
      plan.filter((p) => p.invoice || p.contract).map((p) => `${p.kind}:${p.format}`),
    )
    expect(combos).toContain('invoice:pdf')
    expect(combos).toContain('invoice:docx')
    expect(combos).toContain('contract:pdf')
    expect(combos).toContain('contract:docx')
  })
})

describe('fixture ground truth is internally consistent', () => {
  it('every invoice total equals subtotal + tax when both are printed', () => {
    for (const p of plan) {
      if (p.defect === 'total_mismatch') continue // built to disagree on purpose
      if (p.invoice?.total == null || p.invoice.subtotal === null || p.invoice.tax === null) continue
      const expected = Math.round((p.invoice.subtotal + p.invoice.tax) * 100) / 100
      expect(p.invoice.total, p.file).toBe(expected)
    }
  })

  it('every invoice subtotal equals the sum of its printed line amounts', () => {
    for (const p of plan) {
      if (p.invoice?.subtotal == null || p.invoice.lineItems.length === 0) continue
      const sum = Math.round(p.invoice.lineItems.reduce((a, l) => a + l.amount, 0) * 100) / 100
      expect(p.invoice.subtotal, p.file).toBe(sum)
    }
  })

  it('every line item amount equals quantity x unit price', () => {
    for (const p of plan) {
      for (const line of p.invoice?.lineItems ?? []) {
        expect(line.amount, `${p.file}: ${line.description}`).toBe(
          Math.round(line.quantity * line.unitPrice * 100) / 100,
        )
      }
    }
  })

  it('every contract expiry falls after its effective date', () => {
    for (const p of plan) {
      const c = p.contract
      if (!c?.effectiveDate || !c.expiryDate) continue
      expect(new Date(c.expiryDate).getTime(), p.file).toBeGreaterThan(new Date(c.effectiveDate).getTime())
    }
  })

  it('references only customers that exist in the simulation seed', () => {
    for (const p of plan) {
      if (p.customerId === null) continue
      expect(simIds.has(p.customerId), p.file).toBe(true)
      expect(p.customerName).not.toBeNull()
    }
  })

  it('gives every needs_review fixture an explicit defect and a note', () => {
    const review = plan.filter((p) => p.expectedStatus === 'needs_review')
    expect(review.length).toBeGreaterThan(0)
    for (const p of review) {
      expect(p.notes, p.file).not.toBe('')
      const visibleDefect = p.invoice
        ? p.invoice.dueDate === null ||
          p.invoice.tax === null ||
          p.invoice.invoiceNumber === null ||
          p.invoice.total !== Math.round(((p.invoice.subtotal ?? 0) + (p.invoice.tax ?? 0)) * 100) / 100
        : p.contract
          ? p.contract.effectiveDate === null ||
            p.contract.expiryDate === null ||
            p.contract.contractValue === null ||
            p.contract.terms.length === 0
          : true
      expect(visibleDefect, `${p.file}: needs_review without a visible defect`).toBe(true)
    }
  })
})

describe('manifest CSV', () => {
  it('has a header plus exactly one row per fixture', () => {
    const lines = buildManifestCsv(plan).trimEnd().split('\n')
    expect(lines).toHaveLength(plan.length + 1)
    expect(lines[0]?.startsWith('file,kind,format,expected_status')).toBe(true)
  })

  it('never emits a row with an unquoted comma', () => {
    const header = buildManifestCsv(plan).split('\n')[0]?.split(',').length ?? 0
    for (const row of buildManifestCsv(plan).trimEnd().split('\n').slice(1)) {
      // Count commas outside of double-quoted spans.
      let fields = 1
      let quoted = false
      for (let i = 0; i < row.length; i += 1) {
        const ch = row[i]
        if (ch === '"') quoted = !quoted
        else if (ch === ',' && !quoted) fields += 1
      }
      expect(fields, row).toBe(header)
    }
  })
})
