// src/db/timestamps.ts
/**
 * The one normaliser for a `timestamptz` column read back through node-pg.
 *
 * A row mapper that writes `row.created_at as string` is not carrying a cosmetic
 * cast. The driver hands a `timestamptz` back as a `Date`, so the annotation says
 * one thing and the runtime gives another, and the pair only agrees by accident:
 * `JSON.stringify(new Date())` happens to emit the ISO string every reader wants.
 * The whole-branch review asked for the type to tell the truth, which is why the
 * fix here is a normaliser rather than the second house pattern, a cast that keeps
 * the fiction in place.
 *
 * A value that is neither shape is not coerced. `String({})` is "[object Object]",
 * and a timestamp like that in an approval receipt is worse than a 500: it survives
 * into a report as data. This is the same reasoning that deleted the silent
 * fallback from `getAssetBytes` (`src/db/marketing-assets.ts:112`), and it reaches
 * the same verdict. The `label` names the column so the crash says where.
 *
 * `isoOrNull` exists because the nullable half of this set (`pending_writes.rejected_at`)
 * would otherwise inline the same null test beside the normaliser, and one column's
 * shape is one idea. It keeps the null arm honest rather than letting
 * `toIsoString(null)` turn an un-rejected draft into a crash.
 */
export function toIsoString(value: unknown, label: string): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  throw new Error(`${label} is neither a Date nor a string: ${typeof value}`)
}

export function isoOrNull(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null
  return toIsoString(value, label)
}
