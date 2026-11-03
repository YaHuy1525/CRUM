// src/validation/types.ts
export type Severity = 'error' | 'warning'

export interface Violation {
  ruleId: string
  field: string
  severity: Severity
  message: string
  details?: Record<string, string | number>
}

export interface ValidationContext {
  /** ISO date, injected so a rule that needs today is testable without a clock. */
  today: string
}

export interface DocumentRecordBundle {
  kind: 'invoice' | 'contract'
  invoice?: Record<string, string | null>
  contract?: Record<string, string | null>
  lines: Array<Record<string, string | null>>
  terms: Array<Record<string, string | null>>
}

export interface ValidationRule {
  id: string
  appliesTo: 'invoice' | 'contract'
  /** Columns the rule reads. The review surface uses this to place a finding on a field. */
  fields: string[]
  run(bundle: DocumentRecordBundle, ctx: ValidationContext): Violation[]
}
