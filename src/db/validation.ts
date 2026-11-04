import { getDbClient } from './client.js'
import { toIsoString } from './timestamps.js'
import { docVisibility } from './visibility.js'
import type { TenantRequestContext } from '../mastra/tenant-context.js'
import type { Violation } from '../validation/types.js'
import type { AuditExportRow } from '../api/audit-csv.js'

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
// the tenant in a derived table: `EXPLAIN` on the shipped count shows that table
// never reached the COUNT anyway, because Postgres removes an unreferenced left join
// to a provably unique key, but the page expanded the tenant once per row returned
// (ruling R69, corrected after measurement).
//
// Ruling R69 also decides what the severity clause does to membership, and the
// decision lives here rather than inside the SQL text because a `--` comment in a
// fragment that callers concatenate is one whitespace-flattener away from swallowing
// both statements. Severity is an attribute of findings, not of queue membership, so
// a `needs_review` document whose only open finding is of the other severity, or whose
// only reason to be queued is its status, is correctly hidden by this clause. Pinned by
// tests/api/review-queue.test.ts rather than changed.
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
  // with `EXPLAIN` on the shipped statement: the count plan keeps its join over the
  // findings aggregate, because the membership `WHERE` reads `c.errors` and
  // `c.warnings`, but it holds no `Function Scan` at all, because Postgres removes an
  // unreferenced left join to a provably unique key. The page expanded the tenant once
  // per row it returned.
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

/**
 * The window a review-analytics request reads, as the route resolved it: two absolute
 * instants for the SQL and the two calendar-day labels the panel prints beside them.
 * Ruling R54 — the edges are the operator's local midnights, because "the 90 days ending
 * today" on a UTC-bounded box drops the last day's afternoon rows from every number the
 * panel shows. `fromLabel`/`toLabel` are rendered from the same local zone the edges were
 * built in (ruling R59), so an edge and its own label cannot disagree.
 */
export interface AnalyticsWindow {
  from: Date
  toExclusive: Date
  fromLabel: string
  toLabel: string
  days: number
}

/**
 * Spec 11's six keys plus the window they were computed over. Ruling R68 decides the
 * parameter: a bare `tenantId`, not a `TenantRequestContext`. Every value here is an
 * aggregate over rules, fields, change sources and dates; none of them names a document,
 * a title or a customer, so there is nothing for a row-level visibility rule to protect,
 * and scoping the six queries would silently change what the numbers mean. The
 * consequence is written down so nobody re-files it as a bug: a `user` sees a queue
 * filtered to their own documents and analytics for the whole tenant, so the panel has to
 * label the scope.
 */
export interface ReviewAnalytics {
  window: { from: string; to: string; days: number }
  byRule: Array<{ ruleId: string; total: number; open: number; waived: number }>
  topFields: Array<{ field: string; corrections: number; violations: number }>
  bySource: Array<{ changeSource: string; count: number }>
  correctionRate: { corrected: number; documents: number; rate: number | null }
  turnaround: { p50Hours: number | null; p90Hours: number | null }
  confidenceTrend: Array<{ week: string; avgConfidence: number | null; correctionRate: number | null }>
}

/**
 * Six aggregates over one window. All six share the same binding: `$1` tenant, `$2` from,
 * `$3` to-exclusive, `$4` kind (null for "every kind"), and every aggregate that must reach
 * JavaScript as a number carries an explicit `::int` or `::float8`, because `pg` hands
 * `numeric` and `count` back as strings.
 */
export async function reviewAnalytics(
  tenantId: string,
  window: AnalyticsWindow,
  kind: 'invoice' | 'contract' | null,
): Promise<ReviewAnalytics> {
  const client = getDbClient()
  const p = [tenantId, window.from, window.toExclusive, kind]

  const [byRule, topFields, bySource, rate, turnaround, trend] = await Promise.all([
    client.query<{ rule_id: string; total: number; open: number; waived: number }>(
      `SELECT rule_id,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'open')::int   AS open,
              COUNT(*) FILTER (WHERE status = 'waived')::int AS waived
         FROM document_validation v
        WHERE v.tenant_id = $1
          AND v.created_at >= $2 AND v.created_at < $3
          AND ($4::text IS NULL OR EXISTS (
                SELECT 1 FROM documents kd WHERE kd.id = v.document_id AND kd.kind = $4))
        GROUP BY rule_id
        ORDER BY total DESC, rule_id`,
      p,
    ),
    client.query<{ field: string; corrections: number; violations: number }>(
      `WITH corr AS (
         SELECT a.field_name, COUNT(*)::int AS corrections
           FROM document_field_audit a
          WHERE a.tenant_id = $1 AND a.change_source = 'manual_correction'
            AND a.changed_at >= $2 AND a.changed_at < $3
            AND ($4::text IS NULL OR EXISTS (
                  SELECT 1 FROM documents kd WHERE kd.id = a.document_id AND kd.kind = $4))
          GROUP BY a.field_name
       ), viol AS (
         SELECT v.field_name, COUNT(*)::int AS violations
           FROM document_validation v
          WHERE v.tenant_id = $1
            AND v.created_at >= $2 AND v.created_at < $3
            AND ($4::text IS NULL OR EXISTS (
                  SELECT 1 FROM documents kd WHERE kd.id = v.document_id AND kd.kind = $4))
          GROUP BY v.field_name
       )
       SELECT corr.field_name AS field, corr.corrections, COALESCE(viol.violations, 0) AS violations
         FROM corr LEFT JOIN viol USING (field_name)
        ORDER BY corr.corrections DESC, corr.field_name
          LIMIT 10`,
      p,
    ),
    client.query<{ change_source: string; count: number }>(
      `SELECT a.change_source, COUNT(*)::int AS count
         FROM document_field_audit a
        WHERE a.tenant_id = $1
          AND a.changed_at >= $2 AND a.changed_at < $3
          AND ($4::text IS NULL OR EXISTS (
                SELECT 1 FROM documents kd WHERE kd.id = a.document_id AND kd.kind = $4))
        GROUP BY a.change_source
        ORDER BY count DESC, a.change_source`,
      p,
    ),
    client.query<{ corrected: number; documents: number }>(
      `SELECT
         (SELECT COUNT(DISTINCT a.document_id)::int
            FROM document_field_audit a
           WHERE a.tenant_id = $1 AND a.change_source = 'manual_correction'
             AND a.changed_at >= $2 AND a.changed_at < $3
             AND ($4::text IS NULL OR EXISTS (
                   SELECT 1 FROM documents k1 WHERE k1.id = a.document_id AND k1.kind = $4))) AS corrected,
         (SELECT COUNT(*)::int FROM documents d
           WHERE d.tenant_id = $1 AND d.kind IN ('invoice', 'contract')
             AND ($4::text IS NULL OR d.kind = $4)
             AND d.created_at >= $2 AND d.created_at < $3) AS documents`,
      p,
    ),
    // Ruling R13, carried from R8: the clock starts at `documents.created_at`, so queue
    // wait is inside this number. The panel calls the row "created to first correction"
    // because that is the only place a reader meets the value.
    client.query<{ p50: number | null; p90: number | null }>(
      `WITH first_corr AS (
         SELECT a.document_id, MIN(a.changed_at) AS at
           FROM document_field_audit a
          WHERE a.tenant_id = $1 AND a.change_source = 'manual_correction'
            AND a.changed_at >= $2 AND a.changed_at < $3
          GROUP BY a.document_id
       )
       SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (fc.at - d.created_at)) / 3600
              )::float8 AS p50,
              PERCENTILE_CONT(0.9) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (fc.at - d.created_at)) / 3600
              )::float8 AS p90
         FROM first_corr fc JOIN documents d ON d.id = fc.document_id
        WHERE d.tenant_id = $1 AND d.kind IN ('invoice', 'contract')
          AND ($4::text IS NULL OR d.kind = $4)`,
      p,
    ),
    // Ruling R15: the trend's `correctionRate` is deliberately a different number from the
    // top-level one. It is the share of documents *created* in that ISO week that ever
    // received a correction, window ignored — a per-week version of the top-level metric
    // would put a correction in a week its document was not created in. Hence no `$2`/`$3`
    // inside the EXISTS.
    client.query<{ week: string; avg_confidence: number | null; correction_rate: number | null }>(
      `WITH docs AS (
         SELECT TO_CHAR(DATE_TRUNC('week', d.created_at), 'YYYY-MM-DD') AS week,
                d.confidence::float8 AS conf,
                EXISTS (SELECT 1 FROM document_field_audit a
                         WHERE a.document_id = d.id
                           AND a.change_source = 'manual_correction') AS corrected
           FROM documents d
          WHERE d.tenant_id = $1 AND d.kind IN ('invoice', 'contract')
            AND ($4::text IS NULL OR d.kind = $4)
            AND d.created_at >= $2 AND d.created_at < $3
       )
       SELECT week, AVG(conf)::float8 AS avg_confidence,
              (COUNT(*) FILTER (WHERE corrected))::float8 / NULLIF(COUNT(*), 0) AS correction_rate
         FROM docs GROUP BY week ORDER BY week`,
      p,
    ),
  ])

  const corrected = rate.rows[0]?.corrected ?? 0
  const documents = rate.rows[0]?.documents ?? 0
  return {
    window: { from: window.fromLabel, to: window.toLabel, days: window.days },
    byRule: byRule.rows.map((r) => ({ ruleId: r.rule_id, total: r.total, open: r.open, waived: r.waived })),
    topFields: topFields.rows.map((r) => ({ field: r.field, corrections: r.corrections, violations: r.violations })),
    bySource: bySource.rows.map((r) => ({ changeSource: r.change_source, count: r.count })),
    // Ruling R14: the numerator and the denominator come from two different populations,
    // so the quotient can exceed 1 when a window reviews older work. Both integers travel
    // beside the rate rather than being silently redefined to keep it inside [0, 1].
    correctionRate: { corrected, documents, rate: documents === 0 ? null : corrected / documents },
    turnaround: { p50Hours: turnaround.rows[0]?.p50 ?? null, p90Hours: turnaround.rows[0]?.p90 ?? null },
    confidenceTrend: trend.rows.map((r) => ({
      week: r.week,
      avgConfidence: r.avg_confidence,
      correctionRate: r.correction_rate,
    })),
  }
}

const EXPORT_FIELDS = `
  a.document_id::text,
  d.title AS document_title,
  a.table_name,
  a.field_name,
  a.action,
  a.old_value #>> '{}' AS old_value,
  a.new_value #>> '{}' AS new_value,
  a.changed_by::text,
  TO_CHAR(a.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS changed_at,
  a.change_source,
  a.reason
`

/**
 * Ruling R68: takes the caller's `TenantRequestContext`, not a bare `tenantId`, because
 * this route emits row content (`document_title`, `old_value`, `new_value`, `changed_by`,
 * `reason`) and a tenant-only predicate would let any `user` download the whole tenant's
 * correction history as a file — ruling R67's disclosure in bulk form. The SQL already
 * does `JOIN documents d ON d.id = a.document_id`, so `docVisibility` costs one clause
 * and no new import edge.
 */
export async function exportAuditRows(
  context: TenantRequestContext,
  window: AnalyticsWindow,
  changeSource: string | null,
  kind: 'invoice' | 'contract' | null,
  max: number,
): Promise<AuditExportRow[]> {
  const vis = docVisibility(context)
  // `docVisibility` names `$1` for the tenant in both branches and adds `$2` for the
  // actor only in the `user` branch, so every placeholder after it is derived from
  // its param count. Same arithmetic `reviewQueue` does at lines 235-239.
  const p = vis.params.length
  const params: unknown[] = [
    ...vis.params,
    window.from,
    window.toExclusive,
    changeSource,
    kind,
    max + 1,
  ]
  const result = await getDbClient().query<AuditExportRow>(
    'SELECT ' + EXPORT_FIELDS + `
       FROM document_field_audit a
       JOIN documents d ON d.id = a.document_id
      WHERE ${vis.sql}
        AND a.tenant_id = $1
        AND a.changed_at >= $${p + 1} AND a.changed_at < $${p + 2}
        AND ($${p + 3}::text IS NULL OR a.change_source = $${p + 3})
        AND ($${p + 4}::text IS NULL OR d.kind = $${p + 4})
      ORDER BY a.changed_at DESC, a.id
      LIMIT $${p + 5}`,
    params,
  )
  return result.rows
}
