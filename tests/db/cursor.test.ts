// tests/db/cursor.test.ts
import { describe, expect, it } from 'vitest'
import { parseCursor, generateCursor } from '../../src/db/cursor'

describe('parseCursor', () => {
  it('parses a valid cursor with non-null lowestConfidence', () => {
    const result = parseCursor('5|0.42|2026-11-03T09:00:00.000Z|a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    expect(result).toEqual({
      openErrors: 5,
      lowestConfidence: 0.42,
      createdAt: new Date('2026-11-03T09:00:00.000Z'),
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    })
  })

  it('parses a cursor with null lowestConfidence', () => {
    const result = parseCursor('3|null|2026-11-03T10:00:00.000Z|b2c3d4e5-f6a7-8901-bcde-f12345678901')
    expect(result).toEqual({
      openErrors: 3,
      lowestConfidence: null,
      createdAt: new Date('2026-11-03T10:00:00.000Z'),
      id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    })
  })

  it('returns null for malformed cursor (wrong number of parts)', () => {
    expect(parseCursor('5|0.42|2026-11-03T09:00:00.000Z')).toBeNull()
  })

  it('returns null for malformed cursor (invalid number)', () => {
    expect(parseCursor('abc|0.42|2026-11-03T09:00:00.000Z|a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBeNull()
  })

  it('returns null for malformed cursor (invalid date)', () => {
    expect(parseCursor('5|0.42|not-a-date|a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBeNull()
  })
})

describe('generateCursor', () => {
  it('generates cursor from row with non-null lowestConfidence', () => {
    const row = {
      openErrors: 5,
      lowestFieldConfidence: 0.42,
      createdAt: '2026-11-03T09:00:00.000Z',
      documentId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    }
    expect(generateCursor(row)).toBe('5|0.42|2026-11-03T09:00:00.000Z|a1b2c3d4-e5f6-7890-abcd-ef1234567890')
  })

  it('generates cursor from row with null lowestConfidence', () => {
    const row = {
      openErrors: 3,
      lowestFieldConfidence: null,
      createdAt: '2026-11-03T10:00:00.000Z',
      documentId: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    }
    expect(generateCursor(row)).toBe('3|null|2026-11-03T10:00:00.000Z|b2c3d4e5-f6a7-8901-bcde-f12345678901')
  })
})
