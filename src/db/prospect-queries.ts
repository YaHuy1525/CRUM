import { getDbClient } from './client'
import type { TenantRequestContext } from '../mastra/tenant-context'

export interface ProspectFilters {
  country?: 'AU' | 'VN'
  platform?: string
  band?: 'micro' | 'small' | 'mid' | 'big'
  status?: string
  minScore?: number
  limit?: number
  offset?: number
}

export interface ProspectListItem {
  id: string
  name: string
  country: 'AU' | 'VN'
  category: string | null
  city: string | null
  status: string
  total: number | null
  band: string | null
  platforms: string[]
  audience: number | null
}

export interface ProspectDetail extends ProspectListItem {
  channels: Array<{
    id: string
    platform: string
    handle: string
    profileUrl: string
    audienceCount: number | null
    audienceBasis: string
    audienceConfidence: string
  }>
  snapshot: {
    id: string
    whatTheySell: string | null
    priceMinMinor: number | null
    priceMaxMinor: number | null
    currency: string | null
    weaknessSignals: string[]
    sourceUrl: string | null
    fetchedAt: string
  } | null
  drafts: Array<{ id: string; stage: string; status: string; body: string; language: string }>
}

interface ListRow {
  id: string
  name: string
  country: 'AU' | 'VN'
  category: string | null
  city: string | null
  status: string
  total: string | number | null
  band: string | null
  platforms: string[] | null
  audience: string | number | null
}

interface HeadRow {
  id: string
  name: string
  country: 'AU' | 'VN'
  category: string | null
  city: string | null
  status: string
  total: string | number | null
  band: string | null
}

interface ChannelRow {
  id: string
  platform: string
  handle: string
  profile_url: string
  audience_count: string | number | null
  audience_basis: string
  audience_confidence: string
}

interface SnapshotRow {
  id: string
  what_they_sell: string | null
  price_min_minor: string | number | null
  price_max_minor: string | number | null
  currency: string | null
  weakness_signals: string[] | null
  source_url: string | null
  fetched_at: string
}

interface DraftRow {
  id: string
  stage: string
  status: string
  body: string
  language: string
}

async function queryRows<T>(sql: string, params: unknown[]): Promise<T[]> {
  const result = await getDbClient().query(sql, params)
  return result.rows as T[]
}

function numberOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value)
}

const LIST_SQL = `
  SELECT p.id, p.name, p.country, p.category, p.city, p.status,
         s.total, s.band,
         COALESCE(array_agg(DISTINCT c.platform) FILTER (WHERE c.platform IS NOT NULL), '{}') AS platforms,
         MAX(c.audience_count) AS audience
    FROM prospects p
    LEFT JOIN prospect_scores s ON s.prospect_id = p.id
    LEFT JOIN prospect_channels c ON c.prospect_id = p.id
   WHERE p.tenant_id = $1`

export async function queryProspects(
  rc: TenantRequestContext,
  filters: ProspectFilters,
): Promise<ProspectListItem[]> {
  const params: unknown[] = [rc.tenantId]
  let sql = LIST_SQL

  if (filters.country) {
    params.push(filters.country)
    sql += ` AND p.country = $${params.length}`
  }
  if (filters.platform) {
    params.push(filters.platform)
    sql += ` AND c.platform = $${params.length}`
  }
  if (filters.status) {
    params.push(filters.status)
    sql += ` AND p.status = $${params.length}`
  }
  if (filters.band) {
    params.push(filters.band)
    sql += ` AND s.band = $${params.length}`
  }
  if (typeof filters.minScore === 'number') {
    params.push(filters.minScore)
    sql += ` AND s.total >= $${params.length}`
  }

  sql += ' GROUP BY p.id, s.total, s.band ORDER BY s.total DESC NULLS LAST, p.name ASC'
  params.push(filters.limit ?? 50)
  sql += ` LIMIT $${params.length}`
  params.push(filters.offset ?? 0)
  sql += ` OFFSET $${params.length}`

  const rows = await queryRows<ListRow>(sql, params)
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    country: row.country,
    category: row.category ?? null,
    city: row.city ?? null,
    status: row.status,
    total: numberOrNull(row.total),
    band: row.band ?? null,
    platforms: row.platforms ?? [],
    audience: numberOrNull(row.audience),
  }))
}

export async function queryProspect(
  rc: TenantRequestContext,
  id: string,
): Promise<ProspectDetail | null> {
  const head = await queryRows<HeadRow>(
    `SELECT p.id, p.name, p.country, p.category, p.city, p.status, s.total, s.band
       FROM prospects p
       LEFT JOIN prospect_scores s ON s.prospect_id = p.id
      WHERE p.tenant_id = $1 AND p.id = $2`,
    [rc.tenantId, id],
  )
  const row = head[0]
  if (!row) return null

  const channels = await queryRows<ChannelRow>(
    `SELECT id, platform, handle, profile_url, audience_count, audience_basis, audience_confidence
       FROM prospect_channels WHERE tenant_id = $1 AND prospect_id = $2
      ORDER BY audience_count DESC NULLS LAST`,
    [rc.tenantId, id],
  )
  const snapshot = await queryRows<SnapshotRow>(
    `SELECT id, what_they_sell, price_min_minor, price_max_minor, currency, weakness_signals, source_url, fetched_at
       FROM prospect_snapshots WHERE tenant_id = $1 AND prospect_id = $2
      ORDER BY fetched_at DESC LIMIT 1`,
    [rc.tenantId, id],
  )
  const drafts = await queryRows<DraftRow>(
    `SELECT id, stage, status, body, language FROM outreach_drafts
      WHERE tenant_id = $1 AND prospect_id = $2 ORDER BY created_at DESC LIMIT 10`,
    [rc.tenantId, id],
  )

  const snapshotRow = snapshot[0]
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    category: row.category ?? null,
    city: row.city ?? null,
    status: row.status,
    total: numberOrNull(row.total),
    band: row.band ?? null,
    platforms: channels.map((c) => c.platform),
    audience:
      channels.length === 0
        ? null
        : Math.max(...channels.map((c) => Number(c.audience_count ?? 0))),
    channels: channels.map((c) => ({
      id: c.id,
      platform: c.platform,
      handle: c.handle,
      profileUrl: c.profile_url,
      audienceCount: numberOrNull(c.audience_count),
      audienceBasis: c.audience_basis,
      audienceConfidence: c.audience_confidence,
    })),
    snapshot: snapshotRow
      ? {
          id: snapshotRow.id,
          whatTheySell: snapshotRow.what_they_sell ?? null,
          priceMinMinor: numberOrNull(snapshotRow.price_min_minor),
          priceMaxMinor: numberOrNull(snapshotRow.price_max_minor),
          currency: snapshotRow.currency ?? null,
          weaknessSignals: snapshotRow.weakness_signals ?? [],
          sourceUrl: snapshotRow.source_url ?? null,
          fetchedAt: snapshotRow.fetched_at,
        }
      : null,
    drafts: drafts.map((d) => ({
      id: d.id,
      stage: d.stage,
      status: d.status,
      body: d.body,
      language: d.language,
    })),
  }
}
