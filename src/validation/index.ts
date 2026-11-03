import { RULES } from './rules.js'
import type { DocumentRecordBundle, ValidationContext, ValidationRule, Violation } from './types.js'

export const RULESET_VERSION = 'v1'
export { RULES }
export type * from './types.js'

const SEVERITY_RANK: Record<Violation['severity'], number> = { error: 0, warning: 1 }

export function todayInUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
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
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      return String(value)
    }
    return null
  }
  const toRow = (row: Record<string, unknown>): Record<string, string | null> =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, coerce(value)]))
  const head = header === null ? null : toRow(header)
  return kind === 'invoice'
    ? { kind, invoice: head ?? undefined, lines: lines.map(toRow), terms: [] }
    : { kind, contract: head ?? undefined, terms: terms.map(toRow), lines: [] }
}

export function evaluate(
  bundle: DocumentRecordBundle,
  ctx: ValidationContext,
  rules: readonly ValidationRule[] = RULES,
): Violation[] {
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
    const byRule = a.ruleId.localeCompare(b.ruleId)
    return byRule !== 0 ? byRule : a.field.localeCompare(b.field)
  })
}
