// ── Revenue alerts (Phase 5): database query + detection layer ─────────────
//
// Raw SQL against pg (parameterized, tenant-scoped).  The row type comes from
// ./types; the table contract lives in migrations/0014_crum_billing.sql.
//
// Two rules govern this module:
//   * An alert is ONLY a database row that a human later acknowledges or
//     dismisses.  CRUM never auto-sends anything: no email/SMS/webhook lives
//     here, and detectRevenueAlerts is pure DB math + row writes (no LLM, no
//     network).
//   * De-duplication relies on the partial unique index
//     uq_alert_open_dedup ON revenue_alerts (tenant_id, kind, dedup_key)
//     WHERE status = 'open'.  While an alert of the same condition is still
//     open, a re-detection must not create a duplicate row.
//
// Conventions mirrored from ./sponsorship.ts:
//   * Tenant isolation: every query filters on tenant_id.
//   * Visibility: reads/writes honour the docVisibility rule, aliased to
//     `revenue_alerts a` — an admin sees all tenant rows; a normal user sees
//     tenant-wide rows (no channel/customer), rows they own, or rows linked
//     (directly or via the channel's customer) to a customer they own / are a
//     team member of.
// RevenueAlert has no decimal money columns (metrics is jsonb, already an
// object), so no decimal->number coercion is needed on the way out.

import { getDbClient } from './client'
import { listVideoChannels, getVideoEarningsByChannel } from './video-queries'
import type { TenantRequestContext } from '../mastra/tenant-context'
import type {
  RevenueAlert,
  RevenueAlertKind,
  RevenueAlertSeverity,
  RevenueAlertStatus,
} from './types'

// Re-export types so consumers (API routers / workflow) can import from here.
export type {
  RevenueAlert,
  RevenueAlertKind,
  RevenueAlertSeverity,
  RevenueAlertStatus,
} from './types'

// ── helpers ────────────────────────────────────────────────────────────────

async function queryRows<T>(sql: string, params: unknown[]): Promise<T[]> {
  const result = await getDbClient().query(sql, params)
  return result.rows as T[]
}

async function queryRow<T>(sql: string, params: unknown[]): Promise<T | null> {
  const rows = await queryRows<T>(sql, params)
  return rows[0] ?? null
}

/**
 * Visibility predicate for `revenue_alerts a`, mirroring documents'
 * docVisibility.  Params align with the `$1`/`$2` placeholders used in the SQL.
 */
function alertVisibility(
  context: TenantRequestContext,
): { sql: string; params: unknown[] } {
  if (context.userRole === 'admin') {
    return { sql: 'a.tenant_id = $1', params: [context.tenantId] }
  }
  const ownedCustomers = `(
              SELECT id FROM customers
               WHERE tenant_id = $1 AND deleted_at IS NULL
                 AND (owner_id = $2 OR $2 = ANY(team_member_ids))
            )`
  return {
    sql: `a.tenant_id = $1 AND (
            a.owner_id = $2
            OR (a.customer_id IS NULL AND a.channel_id IS NULL)
            OR a.customer_id IN ${ownedCustomers}
            OR a.channel_id IN (
              SELECT v.id FROM video_channels v
               WHERE v.tenant_id = $1
                 AND v.customer_id IN ${ownedCustomers}
            )
          )`,
    params: [context.tenantId, context.userId],
  }
}

// ── write input ────────────────────────────────────────────────────────────

export interface RevenueAlertWrite {
  channelId?: string | null
  customerId?: string | null
  ownerId?: string | null
  kind: RevenueAlertKind
  severity?: RevenueAlertSeverity
  message: string
  metrics?: Record<string, unknown>
  dedupKey: string
}

/**
 * Insert an alert row, de-duplicating against the partial unique index
 * uq_alert_open_dedup.  INSERT ... ON CONFLICT DO NOTHING returns no row when
 * a still-open duplicate exists; we then look that open row up and report
 * deduped:true.  Defaults: severity='info', metrics={}.
 */
export async function insertRevenueAlert(
  tenantId: string,
  data: RevenueAlertWrite,
): Promise<{ id: string; deduped: boolean }> {
  const inserted = await queryRow<{ id: string }>(
    `INSERT INTO revenue_alerts
       (tenant_id, channel_id, customer_id, owner_id, kind, severity,
        message, metrics, dedup_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (tenant_id, kind, dedup_key) WHERE status = 'open'
     DO NOTHING
     RETURNING id`,
    [
      tenantId,
      data.channelId ?? null,
      data.customerId ?? null,
      data.ownerId ?? null,
      data.kind,
      data.severity ?? 'info',
      data.message,
      JSON.stringify(data.metrics ?? {}),
      data.dedupKey,
    ],
  )
  if (inserted) return { id: inserted.id, deduped: false }

  // No RETURNING row => a still-open duplicate existed (partial unique index).
  const existing = await queryRow<{ id: string }>(
    `SELECT a.id FROM revenue_alerts a
      WHERE a.tenant_id = $1 AND a.kind = $2 AND a.dedup_key = $3
        AND a.status = 'open'
      LIMIT 1`,
    [tenantId, data.kind, data.dedupKey],
  )
  if (!existing) {
    throw new Error('revenue_alerts insert conflicted but no open duplicate was found')
  }
  return { id: existing.id, deduped: true }
}

// ── reads ──────────────────────────────────────────────────────────────────

export interface RevenueAlertFilters {
  status?: RevenueAlertStatus
  kind?: RevenueAlertKind
  channelId?: string
  customerId?: string
}

/**
 * List alert rows visible to `context`, newest first.  Optional filters
 * narrow by status / kind / channel / customer.
 */
export async function listRevenueAlerts(
  context: TenantRequestContext,
  filters: RevenueAlertFilters = {},
  limit = 50,
): Promise<RevenueAlert[]> {
  const vis = alertVisibility(context)
  const conditions: string[] = [vis.sql]
  const params: unknown[] = [...vis.params]
  let idx = params.length

  if (filters.status) {
    idx++
    conditions.push(`a.status = $${idx}`)
    params.push(filters.status)
  }
  if (filters.kind) {
    idx++
    conditions.push(`a.kind = $${idx}`)
    params.push(filters.kind)
  }
  if (filters.channelId) {
    idx++
    conditions.push(`a.channel_id = $${idx}`)
    params.push(filters.channelId)
  }
  if (filters.customerId) {
    idx++
    conditions.push(`a.customer_id = $${idx}`)
    params.push(filters.customerId)
  }

  idx++
  params.push(limit)

  return queryRows<RevenueAlert>(
    `SELECT a.* FROM revenue_alerts a
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${idx}`,
    params,
  )
}

export async function getRevenueAlert(
  context: TenantRequestContext,
  id: string,
): Promise<RevenueAlert | null> {
  const vis = alertVisibility(context)
  const params = [...vis.params, id]
  return queryRow<RevenueAlert>(
    `SELECT a.* FROM revenue_alerts a
      WHERE a.id = $${params.length} AND ${vis.sql}
      LIMIT 1`,
    params,
  )
}

// ── status transition ──────────────────────────────────────────────────────

/**
 * Acknowledge / dismiss / reopen an alert, scoped by visibility.
 * 'acknowledged' stamps acknowledged_at = now(); 'open' clears it.
 * Returns the full updated row, or null when the row is missing or hidden
 * from `context`.
 */
export async function setRevenueAlertStatus(
  context: TenantRequestContext,
  id: string,
  status: RevenueAlertStatus,
): Promise<RevenueAlert | null> {
  const vis = alertVisibility(context)
  const params: unknown[] = [...vis.params]
  let idx = params.length

  const sets: string[] = []
  idx++
  sets.push(`status = $${idx}`)
  params.push(status)

  if (status === 'acknowledged') {
    sets.push('acknowledged_at = now()')
  } else if (status === 'open') {
    sets.push('acknowledged_at = NULL')
  }
  sets.push('updated_at = now()')

  idx++
  params.push(id)

  return queryRow<RevenueAlert>(
    `UPDATE revenue_alerts AS a
        SET ${sets.join(', ')}
      WHERE a.id = $${idx} AND ${vis.sql}
      RETURNING a.*`,
    params,
  )
}

// ── detection ──────────────────────────────────────────────────────────────

export interface DetectionThresholds {
  dropPct: number
  spikePct: number
}

export interface DetectOptions {
  thresholds?: DetectionThresholds
  now?: Date
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Floor an instant to midnight UTC of its own date. */
function floorUtcDate(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function addUtcDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS)
}

/** Format as ISO 'YYYY-MM-DD' (UTC-based, matches floored window edges). */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Normalise an earnings row's date column to 'YYYY-MM-DD' for comparison. */
function isoDay(value: string | Date): string {
  return typeof value === 'string' ? value.slice(0, 10) : toIsoDate(value)
}

/**
 * Decimal guard: pg may hand us estimated_earnings as a string (or null).
 * Coerce to a number, defaulting to 0.
 */
function earningsValue(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  const n = Number(value)
  return Number.isNaN(n) ? 0 : n
}

/**
 * Detect revenue drops/spikes across every channel of a tenant and write
 * alert rows.  PURE DB math + row writes — no LLM, no network, no sending.
 *
 * Windows (ending at `now`, both 7 full UTC days, adjacent & equal-length):
 *   current = [now-6d .. now]   prior = [now-13d .. now-7d]
 *
 * For each channel (self AND client — listVideoChannels is called with {}
 * filters) earnings are fetched ONCE for the whole 14-day span and bucketed
 * by date.  pctChange guards divide-by-zero: prior 0 with a positive current
 * counts as a 100% spike.  Insertion goes through insertRevenueAlert, so the
 * partial unique index keeps re-runs idempotent while an alert is still open.
 */
export async function detectRevenueAlerts(
  tenantId: string,
  opts: DetectOptions = {},
): Promise<{ created: number; skipped: number }> {
  const dropPct = opts.thresholds?.dropPct ?? 0.3
  const spikePct = opts.thresholds?.spikePct ?? 0.5
  const now = opts.now ?? new Date()

  const currentEnd = floorUtcDate(now)
  const currentStart = addUtcDays(currentEnd, -6)
  const priorEnd = addUtcDays(currentEnd, -7)
  const priorStart = addUtcDays(currentEnd, -13)

  const currentStartISO = toIsoDate(currentStart)
  const currentEndISO = toIsoDate(currentEnd)
  const priorStartISO = toIsoDate(priorStart)
  const priorEndISO = toIsoDate(priorEnd)

  const channels = await listVideoChannels(tenantId, {})

  let created = 0
  let skipped = 0

  for (const channel of channels) {
    const earnings = await getVideoEarningsByChannel(tenantId, channel.id, {
      start: priorStartISO,
      end: currentEndISO,
    })

    let current = 0
    let prior = 0
    for (const row of earnings) {
      const day = isoDay(row.date)
      const value = earningsValue(row.estimated_earnings)
      if (day >= priorStartISO && day <= priorEndISO) prior += value
      else if (day >= currentStartISO && day <= currentEndISO) current += value
    }

    // Guard divide-by-zero: a fresh channel with no prior earnings but a
    // positive current window is treated as a +100% spike.
    const pctChange = prior > 0 ? (current - prior) / prior : current > 0 ? 1 : 0

    if (current === 0 && prior === 0) {
      // No data in either window: nothing to look at.
      skipped++
      continue
    }

    const label = channel.channel_name ?? channel.id
    const pct = Math.round(Math.abs(pctChange) * 1000) / 10
    const metrics = { current, prior, pctChange, window: { start: currentStartISO, end: currentEndISO } }

    let alert: RevenueAlertWrite | null = null
    if (pctChange <= -dropPct) {
      alert = {
        channelId: channel.id,
        customerId: channel.customer_id ?? null,
        kind: 'revenue_drop',
        severity: 'warning',
        message: `Revenue fell ${pct}% on channel ${label}`,
        metrics,
        dedupKey: `${channel.id}:${currentEndISO}`,
      }
    } else if (pctChange >= spikePct) {
      alert = {
        channelId: channel.id,
        customerId: channel.customer_id ?? null,
        kind: 'revenue_spike',
        severity: 'info',
        message: `Revenue rose ${pct}% on channel ${label}`,
        metrics,
        dedupKey: `${channel.id}:${currentEndISO}`,
      }
    }

    if (!alert) {
      skipped++
      continue
    }

    const result = await insertRevenueAlert(tenantId, alert)
    if (result.deduped) skipped++
    else created++
  }

  return { created, skipped }
}
