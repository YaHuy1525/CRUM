import { RULES } from './rules.js'
import type { DocumentRecordBundle, ValidationContext, ValidationRule, Violation } from './types.js'

export const RULESET_VERSION = 'v1'
export { RULES }
export type * from './types.js'

const SEVERITY_RANK: Record<Violation['severity'], number> = { error: 0, warning: 1 }

export function todayInUtc(now: Date): string {
  return now.toISOString().slice(0, 10)
}

/**
 * pg parses a `date` column into a JS Date at local midnight, so the stored calendar day
 * has to be read back in local time. `toISOString().slice(0, 10)` would move 2026-11-03 to
 * 2026-11-02 on any machine east of UTC, which is where this project runs and is where the
 * findings get stored. This is a wall-clock-free read: it consults the value's fields and
 * the process timezone, never `Date.now()`, and it is correct precisely because the process
 * that built the Date from the `date` column is the one reading it back. A Postgres `date`
 * has no zone of its own, so a worker running in a different TZ would disagree.
 */
function localDay(value: Date): string {
  const y = String(value.getFullYear())
  const mo = String(value.getMonth() + 1).padStart(2, '0')
  const d = String(value.getDate()).padStart(2, '0')
  return `${y}-${mo}-${d}`
}

export function buildBundle(
  kind: 'invoice' | 'contract',
  header: Record<string, unknown> | null,
  lines: Array<Record<string, unknown>>,
  terms: Array<Record<string, unknown>>,
): DocumentRecordBundle {
  const coerce = (value: unknown): string | null => {
    if (value === null || value === undefined) return null
    if (typeof value === 'string') return value
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
    if (typeof value === 'boolean' || typeof value === 'bigint') return String(value)
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : localDay(value)
    return null
  }
  const toRow = (row: Record<string, unknown>): Record<string, string | null> =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, coerce(value)]))
  const head = header == null ? null : toRow(header)
  return kind === 'invoice'
    ? { kind, invoice: head ?? undefined, lines: lines.map(toRow), terms: [] }
    : { kind, contract: head ?? undefined, terms: terms.map(toRow), lines: [] }
}

export function evaluate(
  bundle: DocumentRecordBundle,
  ctx: ValidationContext,
  rules: readonly ValidationRule[] = RULES,
): Violation[] {
  const header = bundle.kind === 'invoice' ? bundle.invoice : bundle.contract
  if (header === undefined && bundle.lines.length === 0 && bundle.terms.length === 0) return []
  const seen = new Set<string>()
  const found: Violation[] = []
  for (const rule of rules) {
    if (rule.appliesTo !== bundle.kind) continue
    for (const v of rule.run(bundle, ctx)) {
      const key = v.ruleId + '|' + v.field
      if (seen.has(key)) continue
      seen.add(key)
      found.push(v)
    }
  }
  return found.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    if (bySeverity !== 0) return bySeverity
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1
    if (a.field !== b.field) return a.field < b.field ? -1 : 1
    return 0
  })
}
