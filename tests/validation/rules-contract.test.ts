import { describe, expect, it } from 'vitest'
import { buildBundle, evaluate, RULES } from '../../src/validation/index.js'
import type { ValidationContext } from '../../src/validation/types.js'

const CTX: ValidationContext = { today: '2026-11-03' }

const GOOD = {
  counterparty: 'Blue Mountains Physio',
  counterparty_email: 'legal@bmpphysio.example',
  effective_date: '2026-01-01',
  expiry_date: '2026-12-31',
  term_months: 12,
  contract_value: '48000.00',
  currency: 'AUD',
  auto_renewal: true,
  renewal_notice_days: 60,
}

function check(overrides: Record<string, unknown>) {
  return evaluate(buildBundle('contract', { ...GOOD, ...overrides }, [], []), CTX)
}
const ids = (v: ReturnType<typeof check>) => v.map((x) => x.ruleId)

it('fires nothing at all on a compliant contract', () => {
  expect(check({})).toEqual([])
})

it('errors on a missing counterparty and stays silent on a missing value', () => {
  expect(ids(check({ counterparty: null }))).toEqual(['contract.counterparty.present'])
  expect(ids(check({ contract_value: null }))).toEqual([])
})

it('warns on a currency that is not three letters', () => {
  expect(ids(check({ currency: 'AUD$' }))).toContain('contract.currency.shape')
})

it('errors on a negative contract value', () => {
  const hit = check({ contract_value: '-48000' }).find((x) => x.ruleId === 'contract.value.nonnegative')
  expect(hit?.severity).toBe('error')
  expect(hit?.field).toBe('contract_value')
})

it('errors when expiry precedes effect and needs both dates', () => {
  expect(ids(check({ expiry_date: '2025-12-31' }))).toContain('contract.date.order')
  expect(ids(check({ expiry_date: null }))).not.toContain('contract.date.order')
  expect(ids(check({ effective_date: 'n/a' }))).not.toContain('contract.date.order')
})

describe('term_months', () => {
  it('warns outside one to six hundred', () => {
    expect(ids(check({ term_months: 0 }))).toContain('contract.term.range')
    expect(ids(check({ term_months: 601 }))).toContain('contract.term.range')
    expect(ids(check({ term_months: 1 }))).not.toContain('contract.term.range')
    expect(ids(check({ term_months: 600 }))).not.toContain('contract.term.range')
  })
  it('stays silent when absent', () => {
    expect(ids(check({ term_months: null }))).not.toContain('contract.term.range')
  })
})

it('warns on a malformed counterparty email but not on an absent one', () => {
  expect(ids(check({ counterparty_email: 'nope' }))).toContain('contract.counterparty_email.format')
  expect(ids(check({ counterparty_email: null }))).not.toContain('contract.counterparty_email.format')
})

it('never reaches into the other kind', () => {
  for (const violation of check({ counterparty: null, currency: 'X', term_months: 900 })) {
    expect(violation.ruleId.startsWith('contract.')).toBe(true)
  }
})

it('pins the nineteen rule ids across both kinds', () => {
  expect(RULES.length).toBe(19)
  expect(new Set(RULES.map((r) => r.id)).size).toBe(19)
  expect(RULES.filter((r) => r.appliesTo === 'contract').map((r) => r.id).sort()).toEqual([
    'contract.counterparty.present',
    'contract.counterparty_email.format',
    'contract.currency.shape',
    'contract.date.order',
    'contract.term.range',
    'contract.value.nonnegative',
  ])
})
