// tests/db/timestamps.test.ts
import { describe, expect, it } from 'vitest'
import { isoOrNull, toIsoString } from '../../src/db/timestamps'

describe('toIsoString', () => {
  it('normalises the Date node-pg actually hands back', () => {
    expect(toIsoString(new Date('2026-11-02T04:00:00.000Z'), 'x.created_at')).toBe(
      '2026-11-02T04:00:00.000Z',
    )
  })

  it('passes a string through untouched, because a json aggregate can carry one', () => {
    expect(toIsoString('2026-11-02T04:00:00.000Z', 'x.created_at')).toBe('2026-11-02T04:00:00.000Z')
  })

  it('crashes on a value that is neither, naming the column', () => {
    expect(() => toIsoString(1730548800000, 'pending_writes.expires_at')).toThrow(
      'pending_writes.expires_at is neither a Date nor a string: number',
    )
  })

  it('crashes rather than stringifying an object', () => {
    expect(() => toIsoString({}, 'audit_receipts.created_at')).toThrow(/neither a Date nor a string/)
  })

  it('crashes on undefined, because a missing column is not a timestamp', () => {
    // The cast this file replaces silently answered `undefined` when a SELECT
    // forgot a column. A receipt whose `createdAt` is undefined reaches the
    // console as `null` in JSON and reads as "never created" rather than "the
    // query is wrong", so the crash is the only honest answer here.
    expect(() => toIsoString(undefined, 'pending_writes.created_at')).toThrow(
      'pending_writes.created_at is neither a Date nor a string: undefined',
    )
  })
})

describe('isoOrNull', () => {
  it('maps both nulls a nullable column can hand back', () => {
    expect(isoOrNull(null, 'pending_writes.rejected_at')).toBeNull()
    expect(isoOrNull(undefined, 'pending_writes.rejected_at')).toBeNull()
  })

  it('normalises a present value', () => {
    expect(isoOrNull(new Date('2026-11-02T04:00:00.000Z'), 'pending_writes.rejected_at')).toBe(
      '2026-11-02T04:00:00.000Z',
    )
  })
})
