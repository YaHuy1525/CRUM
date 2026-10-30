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

// Fallback for cells where no number sits next to a currency marker: the
// smallest plausible price in each currency's major unit. Anything below this is
// a session count, a ratio ("1:1") or a course index, not money.
const PRICE_FLOOR: Record<Currency, number> = { AUD: 10, VND: 10000 }

// How far from a number a currency marker is still read as belonging to it.
const MARKER_WINDOW = 3

const NUMBER = /\d[\d.,]*/g

function sitsByCurrencyMarker(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - MARKER_WINDOW), start)
  const after = text.slice(end, end + MARKER_WINDOW).toLowerCase()
  return (
    before.includes('$') ||
    before.includes('₫') ||
    after.includes('aud') ||
    after.includes('vnd') ||
    after.includes('đ')
  )
}

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
      const url = new URL(trimmed)
      const segments = url.pathname.split('/').filter(Boolean)
      // A root URL has no profile segment. Falling back to the pathname would
      // give every site the handle "/" and make the import planner treat
      // distinct businesses as duplicates, so the bare hostname identifies it.
      path = segments.at(-1) ?? url.hostname.replace(/^www\./i, '')
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

  // Numbers are read from the raw cell rather than a cleaned copy so that the
  // currency symbol beside them is still there for the adjacency test.
  const candidates: { major: number; adjacent: boolean }[] = []
  for (const match of text.matchAll(NUMBER)) {
    const major = currency === 'VND'
      ? Number(match[0].replace(/[.,]/g, ''))
      : Number(match[0].replace(/,/g, ''))
    if (!Number.isFinite(major)) continue
    candidates.push({
      major,
      adjacent: sitsByCurrencyMarker(text, match.index, match.index + match[0].length),
    })
  }

  // A number next to a currency marker is money whichever currency the row
  // defaults to, so those numbers alone set the range ("1:1 program $2,100" is
  // 210000, not a ratio; "$9.99" is 999). With no such number the floor still
  // has to reject session counts and course indexes.
  const marked = candidates.filter((candidate) => candidate.adjacent)
  const chosen = marked.length > 0
    ? marked
    : candidates.filter((candidate) => candidate.major >= PRICE_FLOOR[currency])
  const exponent = 10 ** CURRENCY_EXPONENT[currency]
  const values = chosen.map((candidate) => Math.round(candidate.major * exponent))

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
