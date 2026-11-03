import { describe, it, expect } from 'vitest'
import { buildBundle, evaluate, RULESET_VERSION } from '../../src/validation/index.js'
import type { ValidationContext, ValidationRule } from '../../src/validation/types.js'

const CTX: ValidationContext = { today: '2026-11-03' }
const invoice = buildBundle('invoice', { total: '10' }, [], [])

function rule(partial: Partial<ValidationRule> & { id: string }, out: never[] | Array<Record<string, unknown>> = []): ValidationRule {
  return {
    appliesTo: 'invoice',
    fields: ['total'],
    run: () => out as never,
    ...partial,
  }
}

describe('evaluate', () => {
  it('skips rules that do not apply to the bundle kind', () => {
    const r = rule({ id: 'contract.x', appliesTo: 'contract' }, [{ ruleId: 'contract.x', field: 'y', severity: 'error', message: 'nope' }])
    expect(evaluate(invoice, CTX, [r])).toEqual([])
  })

  it('puts errors before warnings regardless of catalogue order', () => {
    const warn = rule({ id: 'a.warn' }, [{ ruleId: 'a.warn', field: 'total', severity: 'warning', message: 'w' }])
    const err = rule({ id: 'z.error' }, [{ ruleId: 'z.error', field: 'total', severity: 'error', message: 'e' }])
    expect(evaluate(invoice, CTX, [warn, err]).map((v) => v.severity)).toEqual(['error', 'warning'])
  })

  it('sorts by ruleId then field inside a severity tier so the output is total', () => {
    const r = rule({ id: 'same' }, [
      { ruleId: 'same', field: 'b', severity: 'error', message: '2' },
      { ruleId: 'same', field: 'a', severity: 'error', message: '1' },
      { ruleId: 'other', field: 'z', severity: 'error', message: '0' },
    ])
    expect(evaluate(invoice, CTX, [r]).map((v) => v.ruleId + ':' + v.field))
      .toEqual(['other:z', 'same:a', 'same:b'])
  })

  it('drops an exact ruleId and field duplicate a second rule produces', () => {
    const dup = { ruleId: 'd', field: 'total', severity: 'error', message: 'm' }
    expect(evaluate(invoice, CTX, [rule({ id: 'd' }, [dup]), rule({ id: 'd2' }, [dup])]).length).toBe(1)
  })

  it('is deterministic across calls', () => {
    const rules = [rule({ id: 'x' }, [{ ruleId: 'x', field: 't', severity: 'warning', message: 'm' }])]
    expect(evaluate(invoice, CTX, rules)).toEqual(evaluate(invoice, CTX, rules))
  })

  it('pins the ruleset version so a stored finding says which rules judged it', () => {
    expect(RULESET_VERSION).toBe('v1')
  })

  it('buildBundle keeps lines only for an invoice and terms only for a contract', () => {
    const lines = [{ amount: '1' }]
    const terms = [{ title: 't' }]
    expect(buildBundle('invoice', {}, lines, terms)).toMatchObject({ kind: 'invoice', lines, terms: [] })
    expect(buildBundle('contract', {}, lines, terms)).toMatchObject({ kind: 'contract', terms, lines: [] })
    expect(buildBundle('invoice', null, [], []).invoice).toBeUndefined()
  })
})
