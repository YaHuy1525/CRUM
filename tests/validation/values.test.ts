import { describe, it, expect } from 'vitest'
import { isAbsent, parseAmount, parseDate, isEmail, isCurrencyShape } from '../../src/validation/values.js'

describe('isAbsent', () => {
  it('treats null, undefined and blank as absent but zero as present', () => {
    expect(isAbsent(null)).toBe(true)
    expect(isAbsent(undefined)).toBe(true)
    expect(isAbsent('')).toBe(true)
    expect(isAbsent('   ')).toBe(true)
    expect(isAbsent('0')).toBe(false)
    expect(isAbsent(0)).toBe(false)
    expect(isAbsent(false)).toBe(false)
  })
})

describe('parseAmount', () => {
  it('parses the strings pg returns for numeric', () => {
    expect(parseAmount('1234.56')).toBe(1234.56)
    expect(parseAmount(7)).toBe(7)
  })
  it('strips a currency symbol and thousands separators', () => {
    expect(parseAmount('$1,240.00')).toBe(1240)
  })
  it('reads accounting parentheses as a negative', () => {
    expect(parseAmount('(350.00)')).toBe(-350)
  })
  it('returns null rather than zero for anything that is not a number', () => {
    expect(parseAmount('abc')).toBeNull()
    expect(parseAmount('')).toBeNull()
    expect(parseAmount(null)).toBeNull()
    expect(parseAmount(Number.NaN)).toBeNull()
    expect(parseAmount('-')).toBeNull()
  })
})

describe('parseDate', () => {
  it('normalises an ISO date and a timestamp down to the date', () => {
    expect(parseDate('2026-03-01')).toBe('2026-03-01')
    expect(parseDate('2026-03-01T00:00:00.000Z')).toBe('2026-03-01')
  })
  it('rejects an ambiguous locale string', () => {
    expect(parseDate('01/03/2026')).toBeNull()
  })
  it('rejects a calendar-impossible date instead of rolling it over', () => {
    expect(parseDate('2026-02-30')).toBeNull()
    expect(parseDate('2026-13-01')).toBeNull()
  })
})

describe('isEmail', () => {
  it('accepts an ordinary address and rejects the rest', () => {
    expect(isEmail('billing@acme.com')).toBe(true)
    expect(isEmail('not-an-email')).toBe(false)
    expect(isEmail('a@b')).toBe(false)
    expect(isEmail('')).toBe(false)
  })
})

describe('isCurrencyShape', () => {
  it('accepts three ASCII letters in either case', () => {
    expect(isCurrencyShape('AUD')).toBe(true)
    expect(isCurrencyShape('aud')).toBe(true)
  })
  it('rejects a short code, a long code and a symbol', () => {
    expect(isCurrencyShape('AU')).toBe(false)
    expect(isCurrencyShape('AUSD')).toBe(false)
    expect(isCurrencyShape('$')).toBe(false)
    expect(isCurrencyShape(null)).toBe(false)
  })
})
