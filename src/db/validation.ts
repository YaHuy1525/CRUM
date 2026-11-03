import { getDbClient } from './client.js'
import { toIsoString } from './timestamps.js'
import type { Violation } from '../validation/types.js'

export interface Q {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

export interface StoredViolation {
  id: string
  documentId: string
  rulesetVersion: string
  severity: 'error' | 'warning'
  ruleId: string
  field: string
  message: string
  status: 'open' | 'waived'
  waivedBy: string | null
  waivedAt: string | null
  waiverReason: string | null
  createdAt: string
}
export type WaiveResult = { ok: true; violation: StoredViolation }
export type WaiveFailure = { ok: false; reason: 'not_found' | 'already_waived' }

function rowToStored(row: Record<string, unknown>): StoredViolation {
  return {
    id: row.id as string,
    documentId: row.document_id as string,
    rulesetVersion: row.ruleset_version as string,
    severity: row.severity as 'error' | 'warning',
    ruleId: row.rule_id as string,
    field: row.field_name as string,
    message: row.message as string,
    status: row.status as 'open' | 'waived',
    waivedBy: (row.waived_by as string | null) ?? null,
    waivedAt: row.waived_at == null ? null : toIsoString(row.waived_at, 'document_validation.waived_at'),
    waiverReason: (row.waiver_reason as string | null) ?? null,
    createdAt: toIsoString(row.created_at, 'document_validation.created_at'),
  }
}

const SELECT_COLUMNS = `id, document_id, ruleset_version, severity, rule_id, field_name, message,
        status, waived_by, waived_at, waiver_reason, created_at`

/**
 * Upsert the open findings, refresh the ones that still fire, then drop the open
 * rows this run did not produce. A waived row survives both steps, so an override
 * outlives the re-run that would otherwise erase it.
 */
export async function replaceValidation(
  client: Q,
  documentId: string,
  tenantId: string,
  violations: readonly Violation[],
  rulesetVersion: string,
): Promise<{ openErrors: number; openWarnings: number }> {
  for (const v of violations) {
    await client.query(
      `INSERT INTO document_validation
         (document_id, tenant_id, ruleset_version, severity, rule_id, field_name, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (document_id, rule_id, field_name) DO UPDATE
         SET severity = EXCLUDED.severity,
             message = EXCLUDED.message,
             ruleset_version = EXCLUDED.ruleset_version,
             created_at = now()
         WHERE document_validation.status = 'open'`,
      [documentId, tenantId, rulesetVersion, v.severity, v.ruleId, v.field, v.message],
    )
  }

  if (violations.length > 0) {
    await client.query(
      `DELETE FROM document_validation
       WHERE document_id = $1 AND tenant_id = $2 AND status = 'open'
         AND NOT EXISTS (
           SELECT 1 FROM unnest($3::text[], $4::text[]) AS p(rule, field)
           WHERE p.rule = document_validation.rule_id AND p.field = document_validation.field_name
         )`,
      [
        documentId,
        tenantId,
        violations.map((v) => v.ruleId),
        violations.map((v) => v.field),
      ],
    )
  } else {
    await client.query(
      `DELETE FROM document_validation WHERE document_id = $1 AND tenant_id = $2 AND status = 'open'`,
      [documentId, tenantId],
    )
  }

  const counts = await client.query<{ severity: string; n: string }>(
    `SELECT severity, count(*)::text AS n FROM document_validation
     WHERE document_id = $1 AND tenant_id = $2 AND status = 'open' GROUP BY severity`,
    [documentId, tenantId],
  )
  const of = (s: string) => Number(counts.rows.find((r) => r.severity === s)?.n ?? '0')
  return { openErrors: of('error'), openWarnings: of('warning') }
}

export async function listViolations(documentId: string, tenantId: string): Promise<StoredViolation[]> {
  const rows = await getDbClient().query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM document_validation
     WHERE document_id = $1 AND tenant_id = $2
     ORDER BY CASE severity WHEN 'error' THEN 0 ELSE 1 END, rule_id`,
    [documentId, tenantId],
  )
  return rows.rows.map(rowToStored)
}

export async function waiveViolation(
  violationId: string,
  tenantId: string,
  userId: string,
  reason: string,
): Promise<WaiveResult | WaiveFailure> {
  const updated = await getDbClient().query<Record<string, unknown>>(
    `UPDATE document_validation
     SET status = 'waived', waived_by = $3, waived_at = now(), waiver_reason = $4
     WHERE id = $1 AND tenant_id = $2 AND status = 'open'
     RETURNING ${SELECT_COLUMNS}`,
    [violationId, tenantId, userId, reason],
  )
  if (updated.rows.length > 0) return { ok: true, violation: rowToStored(updated.rows[0]!) }

  const existing = await getDbClient().query<{ id: string }>(
    'SELECT id FROM document_validation WHERE id = $1 AND tenant_id = $2',
    [violationId, tenantId],
  )
  return { ok: false, reason: existing.rows.length === 0 ? 'not_found' : 'already_waived' }
}

export async function openCounts(
  documentIds: readonly string[],
  tenantId: string,
): Promise<Map<string, { errors: number; warnings: number }>> {
  const out = new Map<string, { errors: number; warnings: number }>()
  if (documentIds.length === 0) return out
  const rows = await getDbClient().query<{ document_id: string; severity: string; n: string }>(
    `SELECT document_id, severity, count(*)::text AS n
     FROM document_validation
     WHERE tenant_id = $1 AND document_id = ANY($2::uuid[]) AND status = 'open'
     GROUP BY document_id, severity`,
    [tenantId, [...documentIds]],
  )
  for (const row of rows.rows) {
    const entry = out.get(row.document_id) ?? { errors: 0, warnings: 0 }
    if (row.severity === 'error') entry.errors = Number(row.n)
    else entry.warnings = Number(row.n)
    out.set(row.document_id, entry)
  }
  return out
}
