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

  it('reads VND with dot or comma separators', () => {
    expect(parsePriceRange('2,900,000-3,500,000', 'VN').minMinor).toBe(2900000)
    expect(parsePriceRange('980.000 - 1.200.000', 'VN').maxMinor).toBe(1200000)
  })

  it('returns nulls for unpublished prices', () => {
    const p = parsePriceRange('Not published (enquiry)', 'AU')
    expect(p.minMinor).toBeNull()
    expect(p.maxMinor).toBeNull()
  })

  it('detects a VND price inside an AU row', () => {
    expect(parsePriceRange('5.000.000 VND', 'AU').currency).toBe('VND')
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

  it('refuses to invent a number', () => {
    expect(parseAudience('Not published')).toMatchObject({ count: null, confidence: 'unverified' })
    expect(parseAudience('Max 15 students per cohort').count).toBeNull()
  })
})
