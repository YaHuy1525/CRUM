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
  const last = segments.length > 0 ? segments[segments.length - 1] : path
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

  const values: number[] = []
  for (const token of rawNumbers) {
    const parsed = currency === 'VND'
      ? Number(token.replace(/[.,]/g, ''))
      : Number(token.replace(/,/g, ''))
    if (!Number.isFinite(parsed) || parsed <= 0) continue
    if (parsed < 1 && currency === 'AUD') continue
    values.push(Math.round(parsed * 10 ** CURRENCY_EXPONENT[currency]))
  }

  if (values.length === 0) return { minMinor: null, maxMinor: null, currency }
  return { minMinor: Math.min(...values), maxMinor: Math.max(...values), currency }
}

const DISQUALIFYING = /sold|per cohort|trainees|per year|minimum|sessions|rating|years experience|per course|products/i

function toCount(token: string, suffix?: string): number | null {
  const base = Number(token.replace(/,/g, ''))
  if (!Number.isFinite(base)) return null
  if (!suffix) return base
  const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[suffix.toLowerCase() as 'k' | 'm' | 'b']
  return Math.round(base * multiplier)
}

export function parseAudience(raw: string): Audience {
  const text = (raw ?? '').trim()
  if (text === '' || UNPUBLISHED.test(text) || /^n\/a$/i.test(text)) {
    return { count: null, basis: 'unknown', confidence: 'unverified' }
  }

  let best: { count: number; basis: AudienceBasis } | null = null
  for (const segment of text.split(';')) {
    if (DISQUALIFYING.test(segment)) continue
    const matches = [...segment.matchAll(/(\d[\d,.]*)\s*([KkMmBb])?/g)]
    const counts = matches
      .map((m) => toCount(m[1], m[2]))
      .filter((n): n is number => n !== null && n >= 100)
    if (counts.length === 0) continue
    const count = Math.max(...counts)
    const lowered = segment.toLowerCase()
    let basis: AudienceBasis = 'unknown'
    if (lowered.includes('connection') || lowered.includes('linkedin')) basis = 'linkedin_connections'
    else if (lowered.includes('student') || lowered.includes('learner')) basis = 'students'
    else if (lowered.includes('client') || lowered.includes('coached')) basis = 'clients'
    else basis = 'followers'
    if (best === null || count > best.count) best = { count, basis }
  }

  if (best === null) return { count: null, basis: 'unknown', confidence: 'unverified' }
  const confidence: AudienceConfidence =
    /estimated|~|\+/i.test(text) ? 'approximate' : 'exact'
  return { count: best.count, basis: best.basis, confidence }
}
