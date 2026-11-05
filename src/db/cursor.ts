// src/db/cursor.ts
// Cursor parsing and generation utilities for keyset pagination.
// Cursor format: "open_errors|lowest_field_confidence|created_at|id"

export interface ParsedCursor {
  openErrors: number
  lowestConfidence: number | null
  createdAt: Date
  id: string
}

export interface QueueRow {
  openErrors: number
  lowestFieldConfidence: number | null
  createdAt: string
  documentId: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseCursor(cursor: string): ParsedCursor | null {
  const parts = cursor.split('|')
  if (parts.length !== 4) return null

  const rawOpenErrors = parts[0]
  if (rawOpenErrors === undefined) return null
  const openErrors = Number(rawOpenErrors)
  if (!Number.isInteger(openErrors) || openErrors < 0) return null

  const rawConfidence = parts[1]
  if (rawConfidence === undefined) return null
  const lowestConfidence = rawConfidence === 'null' ? null : Number(rawConfidence)
  if (lowestConfidence !== null && (!Number.isFinite(lowestConfidence) || lowestConfidence < 0 || lowestConfidence > 1)) return null

  const rawDate = parts[2]
  if (rawDate === undefined) return null
  const createdAt = new Date(rawDate)
  if (Number.isNaN(createdAt.getTime())) return null

  const id = parts[3]
  if (id === undefined || !UUID_RE.test(id)) return null

  return { openErrors, lowestConfidence, createdAt, id }
}

export function generateCursor(item: QueueRow): string {
  return `${item.openErrors}|${item.lowestFieldConfidence ?? 'null'}|${item.createdAt}|${item.documentId}`
}
