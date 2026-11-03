import { describe, it, expect } from 'vitest'
import { buildBundle, evaluate, localDay, RULESET_VERSION } from '../../src/validation/index.js'
import { parseDate } from '../../src/validation/values.js'
import type { ValidationContext, ValidationRule, Violation } from '../../src/validation/types.js'

const CTX: ValidationContext = { today: '2026-11-03' }
const invoice = buildBundle('invoice', { total: '10' }, [], [])

function rule(partial: Partial<ValidationRule> & { id: string }, out: Violation[] = []): ValidationRule {
  return {
    appliesTo: 'invoice',
    fields: ['total'],
    run: () => out,
    ...partial,
  }
}

describe('localDay', () => {
  it('renders the day an instant falls on locally, including the early-morning hours', () => {
    // 00:30 is the hour that matters: this project runs at UTC+11, so a UTC read of a local
    // early-morning instant returns the day before. Inputs are built from local components, so a
    // correct implementation passes in any zone. The limit is the mirror of that: on a machine whose
    // offset is exactly zero both reads agree and this case cannot kill a UTC implementation. It
    // kills one here, measured at getTimezoneOffset() = -660, and the mutation was run.
    expect(localDay(new Date(2026, 10, 3, 0, 30, 0))).toBe('2026-11-03')
    expect(localDay(new Date(2026, 10, 3, 23, 59, 59))).toBe('2026-11-03')
    expect(localDay(new Date(2026, 10, 4))).toBe('2026-11-04')
  })

  it('requires the caller to supply the instant so the module never reads the clock', () => {
    // A default argument would make this a wall-clock read inside src/validation/, which
    // constraint 6 forbids. `npx tsc --noEmit` covers tests/, and reports TS2578 "Unused
    // '@ts-expect-error' directive" on the line below if anyone reintroduces one.
    // @ts-expect-error - value is required
    const callableWithoutAnInstant: () => string = localDay
    expect(callableWithoutAnInstant).toBeTypeOf('function')
  })

  it('is the single renderer, so a stored date and ctx.today cannot end up in different frames', () => {
    // The only catalogue rule that consumes ctx.today is invoice.invoice_date.future, whose body is
    // `parseDate(invoice_date) > ctx.today`. Before R45 the two halves came from two helpers in two
    // frames, and that fired a warning on an invoice dated the auditor's own business day for 11 of
    // 24 hours. There is now one renderer for both sides, so the first two lines below are the same
    // computation the boundary performs, and killing `localDay` kills both sides at once.
    const stamped = new Date(2026, 10, 3)
    const bundle = buildBundle('invoice', { invoice_date: stamped }, [], [])
    const future: ValidationRule = {
      id: 'invoice.invoice_date.future',
      appliesTo: 'invoice',
      fields: ['invoice_date'],
      run: (b, ctx) => {
        const d = parseDate(b.invoice?.invoice_date)
        return d !== null && d > ctx.today
          ? [{ ruleId: 'invoice.invoice_date.future', field: 'invoice_date', severity: 'warning', message: 'Invoice date is after today.' }]
          : []
      },
    }
    expect(bundle.invoice?.invoice_date).toBe('2026-11-03')
    expect(evaluate(bundle, { today: localDay(stamped) }, [future])).toEqual([])
    expect(evaluate(bundle, { today: '2026-11-02' }, [future])).toHaveLength(1)
  })
})

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
    // Annotated on purpose: an unannotated extraction of this literal loses its contextual
    // type, widens `severity` to `string`, and fails TS2322 against `out: Violation[]`. The
    // annotation keeps the compiler checking the fixture instead of casting the widening away.
    const dup: Violation = { ruleId: 'd', field: 'total', severity: 'error', message: 'm' }
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

  it('coerces row values at the bundle boundary so pg numbers and booleans arrive as strings', () => {
    const b = buildBundle('invoice', { total: 12, auto_renewal: true, blank: null }, [{ qty: 3 }], [])
    expect(b.invoice).toEqual({ total: '12', auto_renewal: 'true', blank: null })
    expect(b.lines).toEqual([{ qty: '3' }])
  })

  it('reads an object-valued column as absent rather than as [object Object]', () => {
    expect(buildBundle('invoice', { meta: { a: 1 } }, [], []).invoice).toEqual({ meta: null })
  })

  it('renders a pg date Date as the stored calendar day, not the UTC-shifted one', () => {
    // pg builds a `date` column as a Date at local midnight. A toISOString() read here would
    // turn 2026-11-03 into 2026-11-02 on any machine east of UTC, which is where this project
    // writes and reads. The input is built in local time, so the case *passes* in any zone; it
    // only *kills* a UTC implementation where the offset is not zero, which is true of this box
    // and is measured in the localDay case above rather than hidden here.
    expect(buildBundle('invoice', { invoice_date: new Date(2026, 10, 3) }, [], []).invoice)
      .toEqual({ invoice_date: '2026-11-03' })
    expect(buildBundle('invoice', { invoice_date: new Date('not a date') }, [], []).invoice)
      .toEqual({ invoice_date: null })
  })

  it('reads a NaN or infinite amount as absent rather than as a number', () => {
    const b = buildBundle('invoice', { total: Number.NaN, tax: Number.POSITIVE_INFINITY }, [], [])
    expect(b.invoice).toEqual({ total: null, tax: null })
  })

  it('runs rules against an empty header but drops them all when there is no header and no rows', () => {
    const wouldFire = rule({ id: 'invoice.needs_vendor', fields: ['vendor_name'] }, [
      { ruleId: 'invoice.needs_vendor', field: 'vendor_name', severity: 'error', message: 'absent' },
    ])
    // {} is a record whose fields are all missing, which is exactly what a rule judges.
    // null is no record at all, and there is nothing here for any of the 19 rules to say.
    expect(evaluate(buildBundle('invoice', {}, [], []), CTX, [wouldFire]).length).toBe(1)
    expect(evaluate(buildBundle('invoice', null, [], []), CTX, [wouldFire])).toEqual([])
  })

  it('runs rules for a bundle that has rows even when its header is absent, in both kinds', () => {
    const firesOnInvoice = rule({ id: 'invoice.needs_vendor', fields: ['vendor_name'] }, [
      { ruleId: 'invoice.needs_vendor', field: 'vendor_name', severity: 'error', message: 'absent' },
    ])
    const firesOnContract = rule({ id: 'contract.needs_party', appliesTo: 'contract', fields: ['party'] }, [
      { ruleId: 'contract.needs_party', field: 'party', severity: 'error', message: 'absent' },
    ])
    // A mutation check found the all-empty case above pins the guard in one direction only: a guard
    // reading `header === undefined` on its own keeps every earlier test green while silencing the
    // `*.present` rules for a record that does have rows. These three assertions each kill one term
    // of the real condition, and the third is what exercises the `bundle.kind` selection, which is
    // otherwise dead under test — hard-wiring it to `bundle.invoice` survives the first two.
    expect(evaluate(buildBundle('invoice', null, [{ amount: '1' }], []), CTX, [firesOnInvoice])).toHaveLength(1)
    expect(evaluate(buildBundle('contract', null, [], [{ description: 'x' }]), CTX, [firesOnContract])).toHaveLength(1)
    expect(evaluate(buildBundle('contract', { total: '10' }, [], []), CTX, [firesOnContract])).toHaveLength(1)
  })

  it('orders by codepoint, not locale collation, so the order survives a locale change', () => {
    const r = rule({ id: 'same' }, [
      { ruleId: 'same', field: 'a', severity: 'error', message: '1' },
      { ruleId: 'same', field: 'B', severity: 'error', message: '2' },
    ])
    // localeCompare in en-US puts 'a' before 'B'; a codepoint compare puts 'B' (66) first.
    expect(evaluate(invoice, CTX, [r]).map((v) => v.field)).toEqual(['B', 'a'])
  })

  it('orders ruleIds by codepoint too, so the arm that picks between rules is covered', () => {
    const lower = rule({ id: 'a.r' }, [{ ruleId: 'a.r', field: 'total', severity: 'error', message: '1' }])
    const upper = rule({ id: 'B.r' }, [{ ruleId: 'B.r', field: 'total', severity: 'error', message: '2' }])
    // This case exists because a mutation check caught the gap: reverting the ruleId arm to
    // localeCompare left every earlier test green, because the field arm is a separate line
    // of the comparator and only the field arm had a discriminating case. Measured:
    // 'a.r'.localeCompare('B.r') is -1, codepoint puts 'B.r' first.
    expect(evaluate(invoice, CTX, [lower, upper]).map((v) => v.ruleId)).toEqual(['B.r', 'a.r'])
  })
})
