import { getDbClient } from './client.js'
import { toIsoString } from './timestamps.js'
import { docVisibility } from './visibility.js'
import type { TenantRequestContext } from '../mastra/tenant-context.js'
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

export async function listViolations(
  documentId: string,
  tenantId: string,
  client: Q = getDbClient(),
): Promise<StoredViolation[]> {
  const rows = await client.query<Record<string, unknown>>(
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

export interface ReviewQueueItem {
  documentId: string
  title: string
  kind: 'invoice' | 'contract'
  status: string
  confidence: number | null
  lowestFieldConfidence: number | null
  openErrors: number
  openWarnings: number
  reasons: string[]
  createdAt: string
}

export interface ReviewQueueFilter {
  kind: 'invoice' | 'contract' | null
  severity: 'error' | 'warning' | null
  limit: number
  offset: number
}

/**
 * One queue row as the database renders it: `numeric` and `count` arrive as
 * strings from `pg`, so the mapping to `ReviewQueueItem` numbers happens in the
 * route (ruling R57), never here. `created_at` is a `timestamptz` and `pg` hands
 * it back as a `Date`, so the annotation says what the driver actually gives and
 * the route normalises it through `toIsoString` like every other timestamp here.
 */
export interface ReviewQueueRow {
  document_id: string
  title: string
  kind: 'invoice' | 'contract'
  status: string
  confidence: string | null
  lowest_field_confidence: string | null
  open_errors: number
  open_warnings: number
  created_at: Date
}

// Membership is status OR open findings: a correction can clear every finding
// while the document stays `ready`, and a back-dated row can bypass the intake
// trigger, so status alone is not the queue (spec §9.1).
//
// The visibility predicate of ruling R62 is composed with that membership clause,
// not swapped in for it. `docVisibility` binds the tenant as `$1` in both branches,
// so the derived tables may name `$1` literally while every filter, page and offset
// placeholder is numbered from the length of its params — one for an `admin`, two for
// a `user`, which is why these cannot be hard-coded as `$2` through `$5`.
//
// Only the finding-count aggregate is joined here, because the `WHERE` block below
// reads it. Lowest field confidence is not a membership clause, so it is computed
// per row in the page's select list instead of over every invoice and contract of
// the tenant in a derived table this shared fragment would have to carry into the
// COUNT as well (ruling R69).
function queueFrom(
  visibilitySql: string,
  kindRef: string,
  severityRef: string,
): string {
  return `
  FROM documents d
  LEFT JOIN (
    SELECT document_id,
           COUNT(*) FILTER (WHERE severity = 'error')   AS errors,
           COUNT(*) FILTER (WHERE severity = 'warning') AS warnings
    FROM document_validation
    WHERE tenant_id = $1 AND status = 'open'
    GROUP BY document_id
  ) c ON c.document_id = d.id
  WHERE ${visibilitySql}
    AND d.kind IN ('invoice', 'contract')
    AND (${kindRef}::text IS NULL OR d.kind = ${kindRef})
    AND (d.status = 'needs_review' OR COALESCE(c.errors, 0) + COALESCE(c.warnings, 0) > 0)
    -- Ruling R69: severity is an attribute of findings, not of queue membership, so a
    -- needs_review document whose only open finding is of the other severity, or whose
    -- only reason to be queued is its status, is correctly hidden by this clause.
    -- Pinned by tests/api/review-queue.test.ts rather than changed.
    AND (${severityRef}::text IS NULL OR EXISTS (
      SELECT 1 FROM document_validation s
      WHERE s.document_id = d.id AND s.tenant_id = $1
        AND s.status = 'open' AND s.severity = ${severityRef}
    ))
`
}

export async function reviewQueue(
  context: TenantRequestContext,
  filter: ReviewQueueFilter,
): Promise<{ rows: ReviewQueueRow[]; total: number }> {
  const client = getDbClient()
  const vis = docVisibility(context)
  const params: unknown[] = [
    ...vis.params,
    filter.kind,
    filter.severity,
    filter.limit,
    filter.offset,
  ]
  const firstFilter = vis.params.length + 1
  const kindRef = `$${firstFilter}`
  const severityRef = `$${firstFilter + 1}`
  const limitRef = `$${firstFilter + 2}`
  const offsetRef = `$${firstFilter + 3}`
  const from = queueFrom(vis.sql, kindRef, severityRef)

  const countResult = await client.query<{ total: number }>(
    'SELECT COUNT(*)::int AS total' + from,
    // The count statement carries no LIMIT or OFFSET to bind, and `pg` counts the
    // parameters of each prepared statement separately.
    params.slice(0, firstFilter + 1),
  )
  // The page paid for this, and only the page. `created_at` goes out bare so `pg`
  // parses the `timestamptz` into a `Date` and the route normalises it (ruling R69),
  // and lowest field confidence is now expanded per surviving row here instead of over
  // every invoice and contract of the tenant in the shared `from` fragment. Measured
  // with `EXPLAIN` on both shapes: the count plan holds an Aggregate over a Seq Scan and
  // no Function Scan at all, because Postgres removes an unreferenced left join to a
  // unique key, so the COUNT never paid the expansion the page did.
  const pageResult = await client.query<ReviewQueueRow>(
    `SELECT d.id AS document_id, d.title, d.kind, d.status, d.confidence,
            d.created_at,
            (SELECT MIN(NULLIF(kv.value, 'null'::jsonb)::numeric)
               FROM jsonb_each(d.field_confidence) AS kv(key, value)) AS lowest_field_confidence,
            COALESCE(c.errors, 0)::int   AS open_errors,
            COALESCE(c.warnings, 0)::int AS open_warnings` +
      from +
      // `lowest_field_confidence` is an output alias, and with the derived table gone
      // no input column of the FROM answers to that name, so Postgres binds it to the
      // select list. `d.id` is the tiebreaker: `created_at` is not unique, and two
      // documents sharing it, their error counts and their lowest confidence would
      // otherwise be ordered arbitrarily and could split across a page boundary.
      ` ORDER BY COALESCE(c.errors, 0) DESC, lowest_field_confidence ASC NULLS LAST,
                 d.created_at ASC, d.id ASC
         LIMIT ${limitRef} OFFSET ${offsetRef}`,
    params,
  )

  return { rows: pageResult.rows, total: countResult.rows[0]?.total ?? 0 }
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
