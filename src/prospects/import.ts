import type { ParsedRow } from './csv'
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
