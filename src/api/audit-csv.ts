export const AUDIT_CSV_HEADER = [
  'document_id', 'document_title', 'table_name', 'field_name', 'action',
  'old_value', 'new_value', 'changed_by', 'changed_at', 'change_source', 'reason',
] as const

export const MAX_EXPORT_ROWS = 50_000
const NEEDS_QUOTING = /[",\r\n]/
// Ruling R60, CWE-1236. A leading `-` is deliberately absent: a credit or refund arrives as
// `-1100.00` in old_value and new_value routinely, and guarding it turns a real number into text
// to defend against a payload those columns never legitimately start with.
const FORMULA_PREFIX = /^[=+@\t]/

export interface AuditExportRow {
  document_id: string
  document_title: string
  table_name: string
  field_name: string
  action: string
  old_value: string | null
  new_value: string | null
  changed_by: string | null
  changed_at: string
  change_source: string
  reason: string | null
}

const FIELDS: readonly (keyof AuditExportRow)[] = AUDIT_CSV_HEADER

export function csvCell(value: string | null): string {
  if (value === null) return ''
  // R60: guard formula injection BEFORE the quoting decision, so a payload containing
  // both a trigger character and a comma is guarded and then quoted.
  const guarded = FORMULA_PREFIX.test(value) ? "'" + value : value
  if (!NEEDS_QUOTING.test(guarded)) return guarded
  return '"' + guarded.replaceAll('"', '""') + '"'
}

export function csvRow(cells: readonly (string | null)[]): string {
  return cells.map(csvCell).join(',') + '\r\n'
}

export function buildAuditCsv(rows: readonly AuditExportRow[]): string {
  const lines = [csvRow([...AUDIT_CSV_HEADER])]
  for (const row of rows) {
    lines.push(csvRow(FIELDS.map((key) => (row[key] == null ? null : String(row[key])))))
  }
  return '\uFEFF' + lines.join('')
}
