export type Currency = 'AUD' | 'VND'

export interface PriceRange {
  minMinor: number | null
  maxMinor: number | null
  currency: Currency | null
}

export type AudienceBasis = 'followers' | 'linkedin_connections' | 'students' | 'clients' | 'unknown'
export type AudienceConfidence = 'exact' | 'approximate' | 'unverified'

export interface Audience {
  count: number | null
  basis: AudienceBasis
  confidence: AudienceConfidence
}

const CURRENCY_EXPONENT: Record<Currency, number> = { AUD: 2, VND: 0 }

// Smallest plausible price in each currency's major unit. Anything below this is
// a session count, a ratio ("1:1") or a course index, not money.
const PRICE_FLOOR: Record<Currency, number> = { AUD: 10, VND: 1000 }

export function normalizeName(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function normalizeHandle(input: string): string {
  const trimmed = input.trim()
  let path = trimmed
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      path = new URL(trimmed).pathname
    } catch {
      path = trimmed
    }
  }
  const segments = path.split('/').filter(Boolean)
  const last = segments.at(-1) ?? path
  return last.replace(/^@/, '').toLowerCase()
}

const UNPUBLISHED = /not published|not publicly|enquiry|inquiry|quote|inbox|chưa niêm yết|liên hệ/i

export function parsePriceRange(raw: string, country: 'AU' | 'VN'): PriceRange {
  const text = (raw ?? '').trim()
  if (text === '' || UNPUBLISHED.test(text)) {
    return { minMinor: null, maxMinor: null, currency: null }
  }

  let currency: Currency = country === 'VN' ? 'VND' : 'AUD'
  if (/A\$|AUD/i.test(text)) currency = 'AUD'
  if (/₫|VND|VNĐ|đồng/i.test(text)) currency = 'VND'

  const cleaned = text.replace(/A\$|\$|₫|VND|VNĐ|đồng/gi, ' ')
  const rawNumbers = cleaned.match(/\d[\d.,]*/g) ?? []
  const floor = PRICE_FLOOR[currency]

  const values: number[] = []
  for (const token of rawNumbers) {
    const parsed = currency === 'VND'
      ? Number(token.replace(/[.,]/g, ''))
      : Number(token.replace(/,/g, ''))
    if (!Number.isFinite(parsed) || parsed < floor) continue
    values.push(Math.round(parsed * 10 ** CURRENCY_EXPONENT[currency]))
  }

  if (values.length === 0) return { minMinor: null, maxMinor: null, currency }
  return { minMinor: Math.min(...values), maxMinor: Math.max(...values), currency }
}

const DISQUALIFYING = /sold|per cohort|trainees|per year|minimum|sessions|rating|years experience|per course|products/i

// How much text around the winning number is read when naming its source. A
// whole `;`-segment is too coarse: "24.5K FB followers and 500 students" is one
// segment but only the 24.5K figure belongs to followers.
const BASIS_CONTEXT = 20

function toCount(token: string, suffix?: string): number | null {
  const base = Number(token.replace(/,/g, ''))
  if (!Number.isFinite(base)) return null
  if (!suffix) return base
  const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[suffix.toLowerCase() as 'k' | 'm' | 'b']
  return Math.round(base * multiplier)
}

function basisOf(context: string): AudienceBasis {
  const lowered = context.toLowerCase()
  if (lowered.includes('connection') || lowered.includes('linkedin')) return 'linkedin_connections'
  if (lowered.includes('student') || lowered.includes('learner')) return 'students'
  if (lowered.includes('client') || lowered.includes('coached')) return 'clients'
  return 'followers'
}

export function parseAudience(raw: string): Audience {
  const text = (raw ?? '').trim()
  if (text === '' || UNPUBLISHED.test(text) || /^n\/a$/i.test(text)) {
    return { count: null, basis: 'unknown', confidence: 'unverified' }
  }

  let best: { count: number; basis: AudienceBasis } | null = null
  for (const segment of text.split(';')) {
    if (DISQUALIFYING.test(segment)) continue
    for (const match of segment.matchAll(/(\d[\d,.]*)\s*([KkMmBb])?/g)) {
      const token = match[1]
      if (token === undefined) continue
      const count = toCount(token, match[2])
      if (count === null || count < 100) continue
      if (best !== null && count <= best.count) continue
      const at = match.index
      const start = Math.max(0, at - BASIS_CONTEXT)
      const context = segment.slice(start, at + match[0].length + BASIS_CONTEXT)
      best = { count, basis: basisOf(context) }
    }
  }

  if (best === null) return { count: null, basis: 'unknown', confidence: 'unverified' }
  const confidence: AudienceConfidence =
    /estimated|~|\+/i.test(text) ? 'approximate' : 'exact'
  return { count: best.count, basis: best.basis, confidence }
}
