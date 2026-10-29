import { describe, expect, it } from 'vitest'
import { normalizeHandle, normalizeName, parseAudience, parsePriceRange } from '../../../src/prospects/normalize'

describe('normalizeName', () => {
  it('strips Vietnamese diacritics so Tran matches Trần', () => {
    expect(normalizeName('Trần Minh Trang')).toBe('tran minh trang')
    expect(normalizeName('Đặng Thuỵ')).toBe('dang thuy')
  })

  it('drops punctuation and collapses whitespace', () => {
    expect(normalizeName('  Jo Green Coaching  ')).toBe('jo green coaching')
    expect(normalizeName('Butler & Co Advisory (Trent Butler)')).toBe('butler co advisory trent butler')
  })
})

describe('normalizeHandle', () => {
  it('reduces profile urls to the last path segment', () => {
    expect(normalizeHandle('https://www.instagram.com/tom_panos/')).toBe('tom_panos')
    expect(normalizeHandle('https://au.linkedin.com/in/jo-green-coach')).toBe('jo-green-coach')
    expect(normalizeHandle('@LadyLolas')).toBe('ladylolas')
  })
})

describe('parsePriceRange', () => {
  it('reads AUD dollars into cents', () => {
    const p = parsePriceRange('A$20/month; A$54/quarter', 'AU')
    expect(p).toEqual({ minMinor: 2000, maxMinor: 5400, currency: 'AUD' })
  })

  it('reads a single number that only makes sense as cents', () => {
    expect(parsePriceRange('$9.99', 'AU')).toEqual({ minMinor: 999, maxMinor: 999, currency: 'AUD' })
  })

  it('takes only the numbers that sit next to a currency marker', () => {
    const ratio = parsePriceRange('1:1 program $2,100', 'AU')
    expect(ratio.minMinor).toBe(210000)
    expect(ratio.maxMinor).toBe(210000)

    const sessions = parsePriceRange('3 sessions for $900', 'AU')
    expect(sessions.minMinor).toBe(90000)
    expect(sessions.maxMinor).toBe(90000)
  })

  it('reads VND with dot or comma separators', () => {
    const commas = parsePriceRange('2,900,000-3,500,000', 'VN')
    expect(commas.minMinor).toBe(2900000)
    expect(commas.maxMinor).toBe(3500000)

    const dots = parsePriceRange('980.000 - 1.200.000', 'VN')
    expect(dots.minMinor).toBe(980000)
    expect(dots.maxMinor).toBe(1200000)
  })

  it('returns nulls for unpublished prices', () => {
    const p = parsePriceRange('Not published (enquiry)', 'AU')
    expect(p.minMinor).toBeNull()
    expect(p.maxMinor).toBeNull()
  })

  it('detects a VND price inside an AU row', () => {
    const p = parsePriceRange('5.000.000 VND', 'AU')
    expect(p.currency).toBe('VND')
    expect(p.minMinor).toBe(5000000)
  })

  it('returns nulls when no number clears the fallback floor', () => {
    const p = parsePriceRange('course 500 and 900', 'VN')
    expect(p.minMinor).toBeNull()
    expect(p.maxMinor).toBeNull()
  })
})

describe('parseAudience', () => {
  it('reads K and M suffixes', () => {
    expect(parseAudience('8.4K IG')).toMatchObject({ count: 8400, basis: 'followers' })
    expect(parseAudience('1.92M IG')).toMatchObject({ count: 1920000, basis: 'followers' })
  })

  it('distinguishes LinkedIn connections from followers', () => {
    expect(parseAudience('3K LinkedIn')).toMatchObject({ count: 3000, basis: 'linkedin_connections' })
  })

  it('takes the largest number across channels', () => {
    expect(parseAudience('1.9K IG; 24.5K FB; 2,000+ puppy parents').count).toBe(24500)
  })

  it('derives the basis from the text next to the number it selected', () => {
    expect(parseAudience('24.5K FB followers and 500 students')).toMatchObject({
      count: 24500,
      basis: 'followers',
    })
  })

  it('refuses to invent a number', () => {
    expect(parseAudience('Not published')).toMatchObject({ count: null, confidence: 'unverified' })
    expect(parseAudience('Max 15 students per cohort').count).toBeNull()
  })
})
