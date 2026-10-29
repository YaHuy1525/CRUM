import { parseProspectRows, type ParsedRow } from './csv'
import { classifyMatch } from './merge'

export interface ExistingProspect {
  // Present when the prospect is already in the database. The CLI resolves a
  // merge candidate against this id, because a name can point at two prospects.
  id?: string
  name: string
  country: 'AU' | 'VN'
  platform: string
  handleNormalized: string
}

export interface MergeCandidatePlan {
  leftName: string
  rightName: string
  reason: 'exact' | 'substring'
  similarity: number
  // The left side is either an existing prospect or an earlier row of the same
  // file; the right side is always this file's row. The ids and indexes let the
  // CLI insert the pair without matching on name_normalized.
  leftProspectId: string | null
  leftInsertIndex: number | null
  rightInsertIndex: number
}

export interface ImportPlan {
  inserts: ParsedRow[]
  duplicates: string[]
  candidates: MergeCandidatePlan[]
  counts: {
    rowsIn: number
    rowsNew: number
    rowsDuplicate: number
    rowsCandidate: number
  }
}

interface KnownProspect {
  name: string
  country: 'AU' | 'VN'
  prospectId: string | null
  insertIndex: number | null
}

function channelKey(platform: string, handle: string): string {
  return `${platform}:${handle}`
}

export function planImport(rows: ParsedRow[], existing: ExistingProspect[]): ImportPlan {
  const takenChannels = new Set(existing.map((e) => channelKey(e.platform, e.handleNormalized)))
  const known: KnownProspect[] = existing.map((e) => ({
    name: e.name,
    country: e.country,
    prospectId: e.id ?? null,
    insertIndex: null,
  }))

  const inserts: ParsedRow[] = []
  const duplicates: string[] = []
  const candidates: MergeCandidatePlan[] = []

  for (const row of rows) {
    const key = channelKey(row.platform, row.handleNormalized)
    if (takenChannels.has(key)) {
      duplicates.push(row.name)
      continue
    }
    takenChannels.add(key)

    // This row lands at this index once it is pushed below; the candidate needs
    // that index now so the CLI can pair it after the insert returns an id.
    const rightInsertIndex = inserts.length
    for (const other of known) {
      const verdict = classifyMatch({ name: row.name, country: row.country }, other)
      if (verdict.kind === 'candidate') {
        candidates.push({
          leftName: other.name,
          rightName: row.name,
          reason: verdict.reason,
          similarity: verdict.similarity,
          leftProspectId: other.prospectId,
          leftInsertIndex: other.insertIndex,
          rightInsertIndex,
        })
        break
      }
    }

    inserts.push(row)
    known.push({
      name: row.name,
      country: row.country,
      prospectId: null,
      insertIndex: rightInsertIndex,
    })
  }

  return {
    inserts,
    duplicates,
    candidates,
    counts: {
      rowsIn: rows.length,
      rowsNew: inserts.length,
      rowsDuplicate: duplicates.length,
      rowsCandidate: candidates.length,
    },
  }
}

// A row in the file that the parser dropped. The CLI refuses to write anything
// when this list is non-empty: a silent drop used to let a 312 row file vanish
// behind a green audit row.
export type RejectionReason =
  | 'missing name'
  | 'non-http profile url'
  | 'blank country'
  | 'unrecognised country'

export type MissingColumn = 'name' | 'country' | 'profile url'

export interface RejectedRow {
  name: string
  reason: RejectionReason
}

export interface ImportInspection {
  rows: ParsedRow[]
  rejected: RejectedRow[]
  dataRows: number
  missingColumns: MissingColumn[]
}

// Mirrors the header aliases in ./csv, so a rejection can name the column that
// caused it. Acceptance is still decided by parseProspectRows one row at a
// time: drift here can mislabel a reason, never import a rejected row.
const NAME_HEADERS = ['business name', 'name']
const COUNTRY_HEADERS = ['country']
const URL_HEADERS = ['profile url', 'url', 'website']

function columnIndex(header: string[], names: string[]): number {
  const lowered = header.map((cell) => cell.trim().toLowerCase())
  for (const name of names) {
    const at = lowered.indexOf(name)
    if (at >= 0) return at
  }
  return -1
}

interface Columns {
  name: number
  country: number
  profileUrl: number
}

function cellAt(raw: string[], index: number): string {
  return index >= 0 ? (raw[index] ?? '').trim() : ''
}

function reasonFor(raw: string[], columns: Columns): RejectionReason {
  if (cellAt(raw, columns.name) === '') return 'missing name'
  if (!cellAt(raw, columns.profileUrl).startsWith('http')) return 'non-http profile url'
  if (cellAt(raw, columns.country) === '') return 'blank country'
  return 'unrecognised country'
}

/**
 * Parses the file row by row and keeps every row the parser would drop, so the
 * caller can refuse the import instead of reporting a smaller success.
 */
export function inspectImportRows(raw: string[][]): ImportInspection {
  const header = raw[0] ?? []
  const dataRows = raw.slice(1)
  const columns: Columns = {
    name: columnIndex(header, NAME_HEADERS),
    country: columnIndex(header, COUNTRY_HEADERS),
    profileUrl: columnIndex(header, URL_HEADERS),
  }

  const missingColumns: MissingColumn[] = []
  if (columns.name < 0) missingColumns.push('name')
  if (columns.country < 0) missingColumns.push('country')
  if (columns.profileUrl < 0) missingColumns.push('profile url')

  const rows: ParsedRow[] = []
  const rejected: RejectedRow[] = []
  for (const dataRow of dataRows) {
    const [parsed] = parseProspectRows([header, dataRow])
    if (parsed) {
      rows.push(parsed)
    } else {
      rejected.push({ name: cellAt(dataRow, columns.name), reason: reasonFor(dataRow, columns) })
    }
  }

  return { rows, rejected, dataRows: dataRows.length, missingColumns }
}

/**
 * Returns the lines to print when the import must not run, or an empty array
 * when the file is safe to write. Refusing on any rejected row turns silent
 * partial loss into a loud failure.
 */
export function importRefusals(inspection: ImportInspection): string[] {
  const { rows, rejected, dataRows, missingColumns } = inspection

  if (rows.length === 0) {
    if (missingColumns.length > 0) {
      return [`refusing to import: no rows parsed; the CSV header has no ${missingColumns.join(' or ')} column`]
    }
    if (dataRows === 0) {
      return ['refusing to import: no rows parsed; the file has a header and no data rows']
    }
    const reasons = [...new Set(rejected.map((row) => row.reason))].sort()
    return [`refusing to import: no rows parsed; all ${dataRows} data rows were rejected (${reasons.join(', ')})`]
  }

  if (rejected.length === 0) return []

  const lines = [`refusing to import: ${rejected.length} of ${dataRows} data rows were rejected`]
  for (const row of rejected.slice(0, 5)) {
    lines.push(`  ${row.name === '' ? '(no name)' : row.name}: ${row.reason}`)
  }
  return lines
}

/**
 * Parameters for the prospect_channels insert, in the exact column order of the
 * SQL in scripts/prospects-import.ts.
 */
export function buildChannelParams(row: ParsedRow, prospectId: string, tenantId: string): unknown[] {
  return [
    tenantId,
    prospectId,
    row.platform,
    row.handle,
    row.handleNormalized,
    row.profileUrl,
    row.audience.count,
    row.audience.basis,
    row.audience.confidence,
  ]
}

/**
 * Parameters for the prospect_snapshots insert, in the exact column order of the
 * SQL in scripts/prospects-import.ts. extractor_version is a SQL literal, so it
 * has no parameter. The price is already in minor units from parsePriceRange:
 * AUD is scaled by 100, VND (exponent 0) is not, and must not be rescaled here.
 */
export function buildSnapshotParams(row: ParsedRow, prospectId: string, tenantId: string): unknown[] {
  return [
    tenantId,
    prospectId,
    row.whatTheySell,
    row.price.minMinor,
    row.price.maxMinor,
    row.price.currency,
    row.price.minMinor !== null,
    row.profileUrl,
  ]
}
