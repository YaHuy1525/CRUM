import { normalizeHandle, normalizeName, parsePriceRange, parseAudience } from './normalize'

export interface ParsedRow {
  name: string
  nameNormalized: string
  country: 'AU' | 'VN'
  city: string | null
  category: string | null
  platform: string
  handle: string
  handleNormalized: string
  profileUrl: string
  description: string | null
  whatTheySell: string | null
  price: ReturnType<typeof parsePriceRange>
  audience: ReturnType<typeof parseAudience>
  location: string | null
  contact: string | null
  notes: string | null
}

export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\r') continue
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    field += ch
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((line) => line.some((cell) => cell.trim() !== ''))
}

const HEADER_ALIASES: Record<keyof ParsedRow | 'price' | 'audience', string[]> = {
  name: ['business name', 'name'],
  nameNormalized: [],
  country: ['country'],
  city: [],
  category: ['category'],
  platform: ['platform'],
  handle: [],
  handleNormalized: [],
  profileUrl: ['profile url', 'url', 'website'],
  description: ['description'],
  whatTheySell: ['what they sell', 'offer'],
  price: ['price range', 'price range (aud)', 'price range (vnd)', 'price'],
  audience: ['followers/customers', 'followers', 'audience'],
  location: ['location'],
  contact: ['contact info', 'contact'],
  notes: ['notes'],
}

function indexOfHeader(header: string[], names: string[]): number {
  const lowered = header.map((h) => h.trim().toLowerCase())
  for (const name of names) {
    const at = lowered.indexOf(name)
    if (at >= 0) return at
  }
  return -1
}

const PLATFORMS = ['instagram', 'linkedin', 'facebook', 'tiktok', 'youtube', 'shopee', 'website', 'email']

function toPlatform(raw: string): string {
  const lowered = raw.toLowerCase()
  const hit = PLATFORMS.find((p) => lowered.includes(p))
  return hit ?? 'website'
}

// Country decides the price exponent, so an unreadable value must never fall
// back to AU: "VN" or "Việt" defaulting to AUD multiplies a VND price by 100.
// Keys are run through normalizeName, which folds "Việt" to "viet" for us.
const COUNTRY_ALIASES: Record<string, 'AU' | 'VN'> = {
  au: 'AU',
  aus: 'AU',
  australia: 'AU',
  vn: 'VN',
  viet: 'VN',
  vietnam: 'VN',
}

function toCountry(raw: string): 'AU' | 'VN' | null {
  return COUNTRY_ALIASES[normalizeName(raw)] ?? null
}

export function parseProspectRows(rows: string[][]): ParsedRow[] {
  if (rows.length < 2) return []
  const header = rows[0]
  if (!header) return []
  const col = {
    name: indexOfHeader(header, HEADER_ALIASES.name),
    country: indexOfHeader(header, HEADER_ALIASES.country),
    category: indexOfHeader(header, HEADER_ALIASES.category),
    platform: indexOfHeader(header, HEADER_ALIASES.platform),
    profileUrl: indexOfHeader(header, HEADER_ALIASES.profileUrl),
    description: indexOfHeader(header, HEADER_ALIASES.description),
    whatTheySell: indexOfHeader(header, HEADER_ALIASES.whatTheySell),
    price: indexOfHeader(header, HEADER_ALIASES.price),
    audience: indexOfHeader(header, HEADER_ALIASES.audience),
    location: indexOfHeader(header, HEADER_ALIASES.location),
    contact: indexOfHeader(header, HEADER_ALIASES.contact),
    notes: indexOfHeader(header, HEADER_ALIASES.notes),
  }
  if (col.name < 0 || col.profileUrl < 0) return []

  const out: ParsedRow[] = []
  for (const raw of rows.slice(1)) {
    const cell = (i: number) => (i >= 0 ? (raw[i] ?? '').trim() : '')
    const name = cell(col.name)
    const profileUrl = cell(col.profileUrl)
    if (!name || !profileUrl.startsWith('http')) continue

    const countryRaw = cell(col.country)
    const country = toCountry(countryRaw)
    if (!country) continue
    const platform = toPlatform(cell(col.platform) || profileUrl)
    const handle = normalizeHandle(profileUrl)

    out.push({
      name,
      nameNormalized: normalizeName(name),
      country,
      city: cell(col.location) || null,
      category: cell(col.category) || null,
      platform,
      handle,
      handleNormalized: handle,
      profileUrl,
      description: cell(col.description) || null,
      whatTheySell: cell(col.whatTheySell) || null,
      price: parsePriceRange(cell(col.price), country),
      audience: parseAudience(cell(col.audience)),
      location: cell(col.location) || null,
      contact: cell(col.contact) || null,
      notes: cell(col.notes) || null,
    })
  }
  return out
}
