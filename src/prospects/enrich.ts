import { parsePriceRange, type Currency, type PriceRange } from './normalize'

export interface EnrichmentInput {
  html: string
  url: string
  platform: string
  country: 'AU' | 'VN'
  // Whether the prospect has a channel row whose platform is 'website'. This is
  // a fact about the record, not an inference from the page being read: the
  // fetcher often reads the Instagram profile of a business that does have a
  // site, and a Carrd one-pager is still the prospect's website.
  hasWebsiteChannel: boolean
}

// The vocabulary score.ts understands. A signal is only ever emitted from a
// positive check (no capture form found, no funnel path found) so a page that
// does have the thing is never reported as missing it.
export type WeaknessSignal =
  | 'no_website'
  | 'no_lead_magnet'
  | 'no_email_capture'
  | 'no_funnel'
  | 'dm_only_sales'
  | 'pricing_hidden'
  | 'dead_social'
  | 'no_online_course'

export interface EnrichmentResult {
  whatTheySell: string | null
  priceVisible: boolean
  priceMinMinor: number | null
  priceMaxMinor: number | null
  currency: Currency | null
  hasWebsite: boolean
  hasLeadMagnet: boolean
  hasEmailCapture: boolean
  hasFunnel: boolean
  weaknessSignals: WeaknessSignal[]
}

// Only evidence of an actual funnel: a campaign page, a named funnel or the
// platform hosting one. Generic conversion words ("register", "đăng ký",
// "sign up") are deliberately absent: they sit in the navigation and footer of
// almost every page, so they cannot distinguish a funnel from a brochure site.
const FUNNEL_TEXT =
  /\bwebinars?\b|\bchallenges?\b|thử thách|\bfunnels?\b|teachable|kajabi|thinkific|payhip/i

// The hosts behind those platform names, checked on links rather than on the
// anchor text so a generic "Enrol now" pointing at a course platform still
// counts.
const FUNNEL_HOST = /teachable|kajabi|thinkific|payhip/i

// A path segment such as /webinar or /challenge is a campaign step.
const FUNNEL_PATH_SEGMENT = /^(?:challenges?|webinars?)(?:[-_].*)?$/

const LEAD_MAGNET_TEXT = new RegExp(
  [
    '\\bfree\\s+(?:guide|ebook|e-book|checklist|check list|template|download|mini[- ]?course|cheat ?sheet|workbook|blueprint|playbook|report|pdf|resource|toolkit|training|masterclass|webinar|challenge|class|lesson|video|quiz|assessment)\\b',
    '\\bdownload\\s+(?:the\\s+)?free\\b',
    '\\bget\\s+(?:the\\s+)?free\\b',
    'tải\\s+(?:miễn phí|ebook|e-?book|tài liệu|cẩm nang|mẫu|biểu mẫu)',
    '(?:ebook|e-?book|sách điện tử|tài liệu|cẩm nang|biểu mẫu|khoá học|khóa học|học thử)[^.!?]{0,24}miễn phí',
    'miễn phí[^.!?]{0,24}(?:ebook|e-?book|sách|tài liệu|cẩm nang|biểu mẫu|khoá học|khóa học)',
    'nhận\\s+(?:miễn phí|ebook|tài liệu)',
    'tặng\\s+(?:kèm\\s+)?(?:ebook|tài liệu|miễn phí)',
    'tai\\s+(?:mien phi|ebook|tai lieu)',
  ].join('|'),
  'i',
)

const EMAIL_CAPTURE_MARKUP =
  /type\s*=\s*["']?email\b|name\s*=\s*["']?email\b|autocomplete\s*=\s*["']?email\b|action\s*=\s*["'][^"']*(?:subscribe|newsletter|opt-?in|signup|sign-up|dang-ky|đăng-ký)[^"']*["']/iu

const EMAIL_CAPTURE_TEXT =
  /\bnewsletter\b|\bsubscribe\b|join (?:my|our|the) (?:email )?list|enter your email|đăng ký nhận|nhận bản tin|để lại email|nhận tin tức/iu

const DM_ONLY = /\bdm (?:me|to)\b|\binbox (?:me|để)\b|nhắn tin/iu

// A currency marker is required: on a whole page a bare number is far more
// often a year, a count or a phone fragment than a price. The optional k/m
// suffix captures shorthand such as "$2k"; it is expanded before parsing.
const PRICE_PATTERN =
  /(?:A\$|AU\$|US\$|\$|AUD|USD|VND|VNĐ)\s*\d[\d.,]*(?:\s*[kKmM](?![a-z]))?|\d[\d.,]*(?:\s*[kKmM](?![a-z]))?\s*(?:₫|VNĐ|VND|AUD|USD|đồng|đ(?!\p{L}))/giu

// A page that quotes another currency cannot be converted without a rate, so
// reporting it in AUD or VND would be wrong. The caller gets nulls instead and
// the prospect stays "pricing hidden" rather than mislabelled.
const FOREIGN_CURRENCY = /\bUSD(?![a-z])|US\$|€|£/iu

const VND_AMOUNT = /₫|vnđ|vnd|đồng|đ(?!\p{L})/iu
const AUD_AMOUNT = /\$|aud\b/iu

const SHORTHAND = /^([^\d]*)(\d[\d.,]*)\s*([kKmM])(?![a-z])/

const MAGNITUDE: Record<string, number> = { k: 1_000, m: 1_000_000 }

const URL_ATTRIBUTE = /(?:href|action|src)\s*=\s*["']([^"']+)["']/gi

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  dollar: '$',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
}

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (entity: string, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1]?.toLowerCase() === 'x'
      const digits = hex ? body.slice(2) : body.slice(1)
      const code = Number.parseInt(digits, hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return entity
      // A lone surrogate cannot be represented as a character; leave the
      // entity alone rather than emitting a replacement character.
      if (code >= 0xd800 && code <= 0xdfff) return entity
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity
  })
}

// Scripts, styles and comments are not page copy. Leaving them in would let a
// tracking snippet containing the word "newsletter" count as a capture form.
function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template\s*>/gi, ' ')
}

function visibleText(markup: string): string {
  return decodeEntities(markup.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function isFunnelLink(value: string, baseUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value, baseUrl)
  } catch {
    return false
  }
  if (FUNNEL_HOST.test(parsed.hostname)) return true
  return parsed.pathname
    .toLowerCase()
    .split('/')
    .some((segment) => FUNNEL_PATH_SEGMENT.test(segment))
}

function hasFunnelLink(markup: string, baseUrl: string): boolean {
  for (const match of markup.matchAll(URL_ATTRIBUTE)) {
    const value = match[1]
    if (value !== undefined && isFunnelLink(value, baseUrl)) return true
  }
  return false
}

function currencyFor(raw: string, country: 'AU' | 'VN'): Currency {
  if (VND_AMOUNT.test(raw)) return 'VND'
  if (AUD_AMOUNT.test(raw)) return 'AUD'
  return country === 'VN' ? 'VND' : 'AUD'
}

// parsePriceRange decides currency from markers and scales AUD by 100 while
// leaving VND in whole dong. Prefixing the marker makes that decision explicit,
// and rewriting the VND marker to the "đ" form puts it inside the adjacency
// window even when the source wrote "₫" or "VNĐ" after a space. A VND amount is
// therefore never read as AUD cents.
function priceSourceFor(raw: string, currency: Currency): string {
  // Drop a leading marker so the normalized one below sits next to the digits.
  const amount = raw.replace(/^(?:A\$|AU\$|US\$|\$|AUD|USD|VND|VNĐ)\s*/iu, '')
  if (currency === 'VND') {
    const marked = amount.replace(/₫/g, 'đ').replace(/vnđ|vnd|đồng/gi, 'đ')
    return `VND ${marked} đ`
  }
  return `AUD $ ${amount}`
}

// "$2k" is shorthand for $2,000 and "$1.5m" for $1,500,000. Expanding the
// digits before parsePriceRange keeps the multiplier out of that parser, which
// only knows plain numbers and separators.
function expandShorthand(token: string): string {
  const match = SHORTHAND.exec(token)
  if (match === null) return token
  const prefix = match[1] ?? ''
  const digits = match[2] ?? ''
  const suffix = match[3] ?? ''
  const base = Number(digits.replace(/,/g, ''))
  const multiplier = MAGNITUDE[suffix.toLowerCase()]
  if (!Number.isFinite(base) || multiplier === undefined) return token
  return `${prefix}${Math.round(base * multiplier)}`
}

interface FoundPrice {
  min: number
  max: number
}

function extractPrice(text: string, country: 'AU' | 'VN'): PriceRange {
  // Another currency has no exchange rate here, so no amount from this page can
  // be labelled AUD or VND honestly.
  if (FOREIGN_CURRENCY.test(text)) return { minMinor: null, maxMinor: null, currency: null }

  const found: Record<Currency, FoundPrice[]> = { AUD: [], VND: [] }

  for (const match of text.match(PRICE_PATTERN) ?? []) {
    // "for $2,100." leaves a sentence full stop inside the number token, which
    // would parse as NaN. Currency markers never sit after a separator.
    const raw = expandShorthand(match.replace(/[.,]+$/, ''))
    if (raw === '') continue
    const currency = currencyFor(raw, country)
    const parsed = parsePriceRange(priceSourceFor(raw, currency), country)
    if (parsed.minMinor === null || parsed.maxMinor === null) continue
    // An advertised "$0" is a free tier, not a disclosed price.
    if (parsed.maxMinor <= 0) continue
    found[currency].push({ min: parsed.minMinor, max: parsed.maxMinor })
  }

  const aud = found.AUD.length
  const vnd = found.VND.length
  let currency: Currency | null = null
  if (aud > 0 && vnd > 0) {
    currency = vnd > aud ? 'VND' : aud > vnd ? 'AUD' : country === 'VN' ? 'VND' : 'AUD'
  } else if (aud > 0) {
    currency = 'AUD'
  } else if (vnd > 0) {
    currency = 'VND'
  }

  if (currency === null) return { minMinor: null, maxMinor: null, currency: null }
  const prices = found[currency]
  return {
    minMinor: Math.min(...prices.map((price) => price.min)),
    maxMinor: Math.max(...prices.map((price) => price.max)),
    currency,
  }
}

const H1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i
const TITLE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i

// Stripped tags turn the navigation and footer into one run-on string, so the
// old first-offer sentence was mostly menu noise. The page heading is the one
// place the business says what it sells; <title> is the fallback.
function whatTheySellOf(markup: string): string | null {
  for (const pattern of [H1, TITLE]) {
    const inner = pattern.exec(markup)?.[1]
    if (inner === undefined) continue
    const text = visibleText(inner)
    if (text !== '') return text.slice(0, 200)
  }
  return null
}

export function analysePage(input: EnrichmentInput): EnrichmentResult {
  const markup = stripNoise(input.html)
  const text = visibleText(markup)

  // Presence of a website is a fact about the prospect's channels, never an
  // inference from the page shape or from the platform that happened to be
  // fetched: a Linktree profile cannot turn a real site into "no website".
  const hasWebsite = input.hasWebsiteChannel

  const hasLeadMagnet = LEAD_MAGNET_TEXT.test(text)
  const hasEmailCapture = EMAIL_CAPTURE_MARKUP.test(markup) || EMAIL_CAPTURE_TEXT.test(text)
  // Only funnel evidence counts. An email signup in the footer is a capture
  // step most sites have and does not by itself mean there is a funnel.
  const hasFunnel = FUNNEL_TEXT.test(text) || hasFunnelLink(markup, input.url)

  const price = extractPrice(text, input.country)

  const weaknessSignals: WeaknessSignal[] = []
  if (!hasWebsite) weaknessSignals.push('no_website')
  if (!hasLeadMagnet) weaknessSignals.push('no_lead_magnet')
  if (!hasEmailCapture) weaknessSignals.push('no_email_capture')
  if (!hasFunnel) weaknessSignals.push('no_funnel')
  // DM-only is the absence of every other path, not the presence of a DM link.
  if (DM_ONLY.test(text) && !hasFunnel) weaknessSignals.push('dm_only_sales')
  if (price.minMinor === null) weaknessSignals.push('pricing_hidden')

  return {
    whatTheySell: whatTheySellOf(markup),
    priceVisible: price.minMinor !== null,
    priceMinMinor: price.minMinor,
    priceMaxMinor: price.maxMinor,
    currency: price.currency,
    hasWebsite,
    hasLeadMagnet,
    hasEmailCapture,
    hasFunnel,
    weaknessSignals,
  }
}
