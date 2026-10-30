import { parsePriceRange, type Currency, type PriceRange } from './normalize'

export interface EnrichmentInput {
  html: string
  url: string
  platform: string
  country: 'AU' | 'VN'
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

// A link-in-bio page aggregates links; it is not a website of its own. This is
// the same distinction the import pipeline makes when it treats a link hub as a
// profile channel rather than a site.
const LINK_HUB_HOSTS = [
  'linktr.ee',
  'linkin.bio',
  'beacons.ai',
  'bio.site',
  'bio.link',
  'lnk.bio',
  'carrd.co',
  'stan.store',
  'solo.to',
  'hopp.bio',
  'campsite.bio',
  'allmylinks.com',
  'many.link',
  'tap.bio',
  'milkshake.app',
  'snipfeed.co',
  'linkr.bio',
  'linkfly.to',
  'withkoji.com',
]

// Hosting a course on one of these is evidence of a funnel even when the page
// never uses the word "funnel": the checkout and delivery steps already exist.
const FUNNEL_HOSTS = [
  'teachable.com',
  'kajabi.com',
  'thinkific.com',
  'payhip.com',
  'podia.com',
  'systeme.io',
  'kartra.com',
  'clickfunnels.com',
  'gumroad.com',
  'lemonsqueezy.com',
  'hotmart.com',
  'learnworlds.com',
  'heightsplatform.com',
  'mightynetworks.com',
  'circle.so',
  'calendly.com',
  'cal.com',
  'tidycal.com',
  'savvycal.com',
  'youcanbook.me',
  'acuityscheduling.com',
  'setmore.com',
  'typeform.com',
  'tally.so',
  'jotform.com',
  'forms.gle',
  'meetings.hubspot.com',
]

// A path segment such as /book-a-call or /dang-ky is a conversion step. Bare
// "join" is deliberately absent: /join-us is usually a careers page.
const FUNNEL_PATH =
  /^(?:book|booking|schedule|apply|application|enrol|enroll|enrolment|enrollment|register|registration|signup|sign-up|checkout|cart|intake|waitlist|webinar|challenge|masterclass|course|courses|join-now|join-today|discovery-call|strategy-call|strategy-session|get-started|start-here|khoa-hoc|dang-ky|dangky|tu-van|dat-lich|mua|thanh-toan)(?:[-_].*)?$/

// Text that describes a step a visitor can take, not merely an offer. "Work
// together" is omitted on purpose: a DM-only profile says it and has no funnel.
const FUNNEL_TEXT = new RegExp(
  [
    'webinar',
    'masterclass',
    'bootcamp',
    '\\bbooking\\b',
    '\\bchallenge\\b',
    '\\bwaitlist\\b',
    '\\b(?:sign ?up|register|registration|enrol|enroll|enrolment|enrollment)\\b',
    '\\bapply now\\b',
    '\\bbook\\b[^.!?]{0,24}\\b(?:call|session|consult|discovery)\\b',
    '\\b(?:discovery|strategy|consultation) (?:call|session)\\b',
    '\\bschedule (?:a|your) (?:free )?(?:call|session)\\b',
    '\\bfree consultation\\b',
    '\\bfree trial\\b',
    '\\bget started\\b',
    '\\bstart (?:your|the) (?:course|program|programme|journey)\\b',
    '\\bjoin (?:the|now|today)\\b',
    '\\bbuy now\\b',
    '\\badd to cart\\b',
    '\\bcheckout\\b',
    '\\b(?:pre-?order|purchase now)\\b',
    '\\bwork with me\\b',
    '\\bfree (?:training|class|lesson|course|workshop)\\b',
    'đăng ký',
    'ghi danh',
    'đặt lịch',
    'đặt chỗ',
    'nhận tư vấn',
    'tư vấn miễn phí',
    'mua ngay',
    'thanh toán',
    'giỏ hàng',
    'học thử',
    'dang ky',
    'dat lich',
    'nhan tu van',
    'thanh toan',
    'hoc thu',
  ].join('|'),
  'i',
)

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

const OFFER_TEXT =
  /course|coach|program|mentor|mastermind|membership|bootcamp|workshop|khoá học|khóa học|khoa hoc|tư vấn|đào tạo/i

// A currency marker is required: on a whole page a bare number is far more
// often a year, a count or a phone fragment than a price.
const PRICE_PATTERN =
  /(?:A\$|AU\$|US\$|\$|AUD|USD|VND|VNĐ)\s*\d[\d.,]*|\d[\d.,]*\s*(?:₫|VNĐ|VND|AUD|USD|đồng|đ(?!\p{L}))/giu

const VND_AMOUNT = /₫|vnđ|vnd|đồng|đ(?!\p{L})/iu
const AUD_AMOUNT = /\$|aud\b/iu

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

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return null
  }
}

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`)
}

function isLinkHub(url: string): boolean {
  const host = hostOf(url)
  return host !== null && LINK_HUB_HOSTS.some((hub) => hostMatches(host, hub))
}

function isFunnelLink(value: string, baseUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value, baseUrl)
  } catch {
    return false
  }
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase()
  if (FUNNEL_HOSTS.some((suffix) => hostMatches(host, suffix))) return true
  const segments = parsed.pathname.toLowerCase().split('/')
  return segments.some((segment) => FUNNEL_PATH.test(segment))
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

interface FoundPrice {
  min: number
  max: number
}

function extractPrice(text: string, country: 'AU' | 'VN'): PriceRange {
  const found: Record<Currency, FoundPrice[]> = { AUD: [], VND: [] }

  for (const match of text.match(PRICE_PATTERN) ?? []) {
    // "for $2,100." leaves a sentence full stop inside the number token, which
    // would parse as NaN. Currency markers never sit after a separator.
    const raw = match.replace(/[.,]+$/, '')
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

function firstOffer(text: string): string | null {
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (!OFFER_TEXT.test(sentence)) continue
    const trimmed = sentence.trim()
    if (trimmed !== '') return trimmed.slice(0, 200)
  }
  return null
}

export function analysePage(input: EnrichmentInput): EnrichmentResult {
  const markup = stripNoise(input.html)
  const text = visibleText(markup)
  const platform = input.platform.trim().toLowerCase()

  // The channel table only carries a website when its platform says so; a
  // profile URL on a social network is not the prospect's own site.
  const hasWebsite = platform === 'website' && !isLinkHub(input.url)

  const hasLeadMagnet = LEAD_MAGNET_TEXT.test(text)
  const hasEmailCapture = EMAIL_CAPTURE_MARKUP.test(markup) || EMAIL_CAPTURE_TEXT.test(text)
  // A capture step is the first stage of a funnel, so a page with only an
  // opt-in still has one. Campaign wording and conversion links are the other
  // two positive observations.
  const hasFunnel =
    hasEmailCapture || FUNNEL_TEXT.test(text) || hasFunnelLink(markup, input.url)

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
    whatTheySell: firstOffer(text),
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
