// src/db/marketing-metrics.ts
// Slice 3 task 5: insert and query rows in marketing_metrics_snapshots, the
// table migration 0020 created. The cron job calls insertSnapshot after each
// successful metrics read; the analyst cron and the console dashboard call the
// list functions to retrieve historical data.

import { getDbClient } from './client'

export interface MetricsSnapshotRow {
  id: string
  tenantId: string
  bundleId: string
  campaignExternalId: string
  windowStart: string
  windowEnd: string
  metrics: unknown
  createdAt: string
}

interface SnapshotSqlRow {
  id: string
  tenant_id: string
  bundle_id: string
  campaign_external_id: string
  window_start: string
  window_end: string
  metrics: unknown
  created_at: string
}

function toSnapshot(row: SnapshotSqlRow): MetricsSnapshotRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    bundleId: row.bundle_id,
    campaignExternalId: row.campaign_external_id,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    metrics: row.metrics,
    createdAt: row.created_at,
  }
}

/**
 * Stores one metrics snapshot. The `metrics` parameter is the raw JSON response
 * from Meta's Ads Insights API (the `data` array or the full response body);
 * the column is jsonb so the analyst can parse it flexibly later.
 */
export async function insertSnapshot(
  tenantId: string,
  bundleId: string,
  campaignExternalId: string,
  windowStart: string | Date,
  windowEnd: string | Date,
  metrics: unknown,
): Promise<MetricsSnapshotRow> {
  const db = getDbClient()
  const result = await db.query<SnapshotSqlRow>(
    `INSERT INTO marketing_metrics_snapshots
        (tenant_id, bundle_id, campaign_external_id, window_start, window_end, metrics)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, tenant_id, bundle_id, campaign_external_id,
               window_start, window_end, metrics, created_at`,
    [
      tenantId,
      bundleId,
      campaignExternalId,
      windowStart instanceof Date ? windowStart.toISOString() : windowStart,
      windowEnd instanceof Date ? windowEnd.toISOString() : windowEnd,
      JSON.stringify(metrics),
    ],
  )
  return toSnapshot(result.rows[0])
}

/**
 * All snapshots for one campaign, newest window first. The optional `limit`
 * caps the rows returned; the analyst cron uses it to bound the data it passes
 * to the LLM, the console uses it for pagination.
 */
export async function listSnapshots(
  tenantId: string,
  campaignExternalId: string,
  limit?: number,
): Promise<MetricsSnapshotRow[]> {
  const db = getDbClient()
  const sql = limit !== undefined
    ? `SELECT id, tenant_id, bundle_id, campaign_external_id,
              window_start, window_end, metrics, created_at
         FROM marketing_metrics_snapshots
        WHERE tenant_id = $1 AND campaign_external_id = $2
        ORDER BY window_start DESC
        LIMIT $3`
    : `SELECT id, tenant_id, bundle_id, campaign_external_id,
              window_start, window_end, metrics, created_at
         FROM marketing_metrics_snapshots
        WHERE tenant_id = $1 AND campaign_external_id = $2
        ORDER BY window_start DESC`
  const params = limit !== undefined
    ? [tenantId, campaignExternalId, limit]
    : [tenantId, campaignExternalId]
  const result = await db.query<SnapshotSqlRow>(sql, params)
  return result.rows.map(toSnapshot)
}

/**
 * Every snapshot whose window_start falls within the past `days` days. The
 * analyst cron calls this to gather the week's data across all campaigns before
 * invoking the campaign-analyst agent.
 */
export async function listRecentSnapshots(
  tenantId: string,
  days: number,
): Promise<MetricsSnapshotRow[]> {
  const db = getDbClient()
  const result = await db.query<SnapshotSqlRow>(
    `SELECT id, tenant_id, bundle_id, campaign_external_id,
            window_start, window_end, metrics, created_at
       FROM marketing_metrics_snapshots
      WHERE tenant_id = $1
        AND window_start >= now() - ($2::int || ' days')::interval
      ORDER BY window_start DESC`,
    [tenantId, days],
  )
  return result.rows.map(toSnapshot)
}
