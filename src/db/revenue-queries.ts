// ── Video revenue: read aggregation (Phase 6) ──────────────────────────────
//
// The dashboard and the agent read-tools both need revenue ROLLED UP across
// channels/platforms, which the per-row CRUD in video-queries.ts does not
// provide.  This module is the single read-aggregation surface for Phase 6, so
// the REST router and the Mastra tools cannot drift apart on the maths.
//
// Conventions (same as video-queries.ts / sponsorship.ts):
//   * Raw parameterized SQL against pg; every query filters on tenant_id.
//   * These are tenant-scoped by tenantId (like the video_channels CRUD), not
//     per-user-visibility scoped (unlike sponsorship/billing/alerts, which the
//     router reads through their own context-aware layers).
//   * Money is decimal; it is returned as TEXT here so the caller decides on
//     rounding/presentation and no float rounding leaks into a billing view.
//     The REST router and tools pass these strings straight through.

import { getDbClient } from './client'
import type { VideoPlatform, ChannelOwnership, ChannelStatus } from './types'

export type { VideoPlatform, ChannelOwnership, ChannelStatus } from './types'

// ── types ──────────────────────────────────────────────────────────────────

export interface DateRange {
  from?: string // inclusive YYYY-MM-DD
  to?: string // inclusive YYYY-MM-DD
}

/** One row per tracked channel: its identity + rolled-up earnings for a range. */
export interface ChannelRevenueRow {
  channel_id: string
  channel_name: string | null
  platform: VideoPlatform
  ownership: ChannelOwnership
  status: ChannelStatus
  currency: string | null
  /** SUM(estimated_earnings) over the range, decimal as text (never null: COALESCE 0). */
  total_revenue: string
  /** SUM(views_count) over the range, integer. */
  total_views: number
  /** last_sync_at as text (timestamptz), or null when never synced. */
  last_sync_at: string | null
}

/** A single day in a channel's earnings time series. */
export interface EarningsPoint {
  date: string
  revenue: string
  views: number | null
}

/** Tenant-wide revenue roll-up for the dashboard header cards. */
export interface RevenueTotals {
  currency: string | null
  /** SUM over video_earnings for the range, decimal as text. */
  platform_revenue: string
  /** SUM over CONFIRMED sponsorship_income with deal_date in the range, text. */
  sponsorship_revenue: string
  /** platform + sponsorship, decimal-as-text (computed in SQL). */
  grand_total: string
  /** number of channels with earnings rows in the range. */
  channels_with_earnings: number
}

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
 * Build the `AND e.date >= $n::date AND e.date <= $n+1::date` clause pair shared
 * by the earnings queries.  Returns the SQL fragment (empty when no bounds) plus
 * the params in positional order; `startIndex` is the next `$` number to use.
 */
function dateClause(
  range: DateRange,
  col: string,
  startIndex: number,
): { sql: string; params: unknown[]; nextIndex: number } {
  const parts: string[] = []
  const params: unknown[] = []
  let idx = startIndex
  if (range.from) {
    parts.push(`${col} >= $${idx}::date`)
    params.push(range.from)
    idx++
  }
  if (range.to) {
    parts.push(`${col} <= $${idx}::date`)
    params.push(range.to)
    idx++
  }
  return {
    sql: parts.length ? ` AND ${parts.join(' AND ')}` : '',
    params,
    nextIndex: idx,
  }
}

// ── per-channel roll-up ────────────────────────────────────────────────────

/**
 * One row per video_channels row for the tenant, LEFT JOINed to its earnings in
 * the range (so channels with no earnings still appear, with total 0). Ordered
 * by revenue descending. This backs the dashboard channel table.
 */
export async function sumEarningsByChannel(
  tenantId: string,
  range: DateRange = {},
): Promise<ChannelRevenueRow[]> {
  const dc = dateClause(range, 'e.date', 2)
  const params: unknown[] = [tenantId, ...dc.params]
  const joinDate = dc.sql // e.g. " AND e.date >= $2::date AND e.date <= $3::date"

  return queryRows<ChannelRevenueRow>(
    `SELECT v.id                                     AS channel_id,
            v.channel_name,
            v.platform,
            v.ownership,
            v.status,
            min(e.currency)                          AS currency,
            COALESCE(sum(e.estimated_earnings), 0)::text AS total_revenue,
            COALESCE(sum(e.views_count), 0)::int     AS total_views,
            -- UTC ISO string rather than a bare ::text cast: pg renders a
            -- timestamptz in the session timezone ("2026-10-29 14:03:48.835+10"),
            -- which a browser cannot reliably parse back into the same instant.
            to_char(v.last_sync_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"')    AS last_sync_at
       FROM video_channels v
       LEFT JOIN video_earnings e
              ON e.channel_id = v.id
             AND e.tenant_id  = v.tenant_id
            ${joinDate}
      WHERE v.tenant_id = $1
      GROUP BY v.id, v.channel_name, v.platform, v.ownership, v.status, v.last_sync_at
      ORDER BY sum(e.estimated_earnings) DESC NULLS LAST, v.channel_name ASC NULLS LAST`,
    params,
  )
}

// ── per-channel time series ────────────────────────────────────────────────

/** Daily earnings for one channel over a range, oldest first. For a sparkline. */
export async function earningsSeries(
  tenantId: string,
  channelId: string,
  range: DateRange = {},
): Promise<EarningsPoint[]> {
  const dc = dateClause(range, 'date', 3)
  const params: unknown[] = [tenantId, channelId, ...dc.params]
  return queryRows<EarningsPoint>(
    `SELECT date::text                    AS date,
            COALESCE(estimated_earnings, 0)::text AS revenue,
            views_count                   AS views
       FROM video_earnings
      WHERE tenant_id = $1 AND channel_id = $2
            ${dc.sql}
      ORDER BY date ASC`,
    params,
  )
}

// ── tenant totals ──────────────────────────────────────────────────────────

/**
 * Header-card numbers for the whole tenant over a range. `sponsorship` counts
 * only CONFIRMED deals (the semi-automated Phase 4 gate), matching what billing
 * would bill on.
 */
export async function sumRevenueTotals(
  tenantId: string,
  range: DateRange = {},
): Promise<RevenueTotals> {
  const dc = dateClause(range, 'e.date', 2)
  const platform = await queryRow<{ total: string | null; views: number | null; currency: string | null; channels: number }>(
    `SELECT COALESCE(sum(e.estimated_earnings), 0)::text AS total,
            COALESCE(sum(e.views_count), 0)::int        AS views,
            min(e.currency)                             AS currency,
            count(DISTINCT e.channel_id)::int           AS channels
       FROM video_earnings e
      WHERE e.tenant_id = $1
            ${dc.sql}`,
    [tenantId, ...dc.params],
  )

  const sc = dateClause(range, 's.deal_date', 2)
  const sponsorParams: unknown[] = [tenantId, ...sc.params]
  const sponsor = await queryRow<{ total: string | null }>(
    `SELECT COALESCE(sum(s.amount), 0)::text AS total
       FROM sponsorship_income s
      WHERE s.tenant_id = $1
        AND s.status = 'confirmed'
        AND s.amount IS NOT NULL
            ${sc.sql}`,
    sponsorParams,
  )

  const platformTotal = platform?.total ?? '0'
  const sponsorshipTotal = sponsor?.total ?? '0'
  // decimal-safe add of two text money strings (no float rounding into a billing view).
  const grand = exactAddDecimal(platformTotal, sponsorshipTotal)

  return {
    currency: platform?.currency ?? null,
    platform_revenue: platformTotal,
    sponsorship_revenue: sponsorshipTotal,
    grand_total: grand,
    channels_with_earnings: platform?.channels ?? 0,
  }
}

/**
 * Add two decimal strings without float error. Handles an empty/absent operand as
 * '0'. Keeps scale to 2 decimals (money). Used to total platform + sponsorship.
 */
export function exactAddDecimal(a: string | null | undefined, b: string | null | undefined): string {
  const pa = parseFixed(a ?? '0')
  const pb = parseFixed(b ?? '0')
  const sumCents = pa.cents + pb.cents
  const sign = sumCents < 0 ? '-' : ''
  const abs = Math.abs(sumCents)
  const whole = Math.floor(abs / 100)
  const cents = String(abs % 100).padStart(2, '0')
  return `${sign}${whole}.${cents}`
}

function parseFixed(value: string): { cents: number } {
  const trimmed = value.trim()
  if (trimmed === '') return { cents: 0 }
  const neg = trimmed.startsWith('-')
  const unsigned = neg ? trimmed.slice(1) : trimmed
  const [whole, frac = ''] = unsigned.split('.')
  const centsWhole = (Number(whole || '0') || 0) * 100
  const centsFrac = Number((frac + '00').slice(0, 2)) || 0
  const cents = centsWhole + centsFrac
  return { cents: neg ? -cents : cents }
}

// ── alerts open count (dashboard badge) ────────────────────────────────────

/** Count of OPEN revenue alerts for the tenant. Powers the dashboard badge. */
export async function countOpenRevenueAlerts(tenantId: string): Promise<number> {
  const row = await queryRow<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM revenue_alerts
      WHERE tenant_id = $1 AND status = 'open'`,
    [tenantId],
  )
  return row?.count ?? 0
}
