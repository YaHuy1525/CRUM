// ── Video revenue tracking: database query layer ───────────────────────────
//
// Raw SQL against pg (parameterized, tenant-scoped).  Every function takes
// `tenantId` as its first argument so multi-tenancy is enforced at the query
// level, matching the pattern established in ./queries.ts.
//
// Tables: video_channels, oauth_tokens, video_earnings, video_audience_metrics

import { getDbClient } from './client'
import type { TenantRequestContext } from '../mastra/tenant-context'
import type {
  VideoChannel,
  VideoPlatform,
  ChannelOwnership,
  ChannelStatus,
  OAuthToken,
  VideoEarning,
  VideoAudienceMetric,
} from './types'

// Re-export types so consumers (API routers) can import everything from here.
export type {
  VideoChannel,
  VideoPlatform,
  ChannelOwnership,
  ChannelStatus,
  OAuthToken,
  VideoEarning,
  VideoAudienceMetric,
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

export interface ListPage {
  limit: number
  offset: number
}

export interface ListResult<T> {
  items: T[]
  total: number
}

// ═══════════════════════════════════════════════════════════════════════════
//  video_channels
// ═══════════════════════════════════════════════════════════════════════════

interface InsertVideoChannelData {
  platform: VideoPlatform
  platformChannelId: string
  channelName?: string
  channelUrl?: string
  customerId?: string
  contactId?: string
  ownership?: ChannelOwnership
  status?: ChannelStatus
}

async function insertVideoChannelBase(
  tenantId: string,
  platform: VideoPlatform,
  platformChannelId: string,
  channelName: string | null = null,
  channelUrl: string | null = null,
  customerId: string | null = null,
  contactId: string | null = null,
  ownership: ChannelOwnership = 'self',
  status: ChannelStatus = 'active',
): Promise<VideoChannel> {
  const row = await queryRow<VideoChannel>(
    `INSERT INTO video_channels
       (tenant_id, platform, platform_channel_id, channel_name, channel_url,
        customer_id, contact_id, ownership, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [tenantId, platform, platformChannelId, channelName, channelUrl,
     customerId, contactId, ownership, status],
  )
  if (!row) throw new Error('video_channels insert returned no row')
  return row
}

/**
 * Insert a video channel.
 *
 * Two calling conventions are supported:
 *   - Base:      insertVideoChannel(tenantId, platform, platformChannelId, ...)
 *   - API router: insertVideoChannel(context, { platform, platformChannelId, ... })
 */
export async function insertVideoChannel(
  contextOrTenantId: TenantRequestContext | string,
  platformOrData: VideoPlatform | InsertVideoChannelData,
  platformChannelId?: string,
  channelName?: string | null,
  channelUrl?: string | null,
  customerId?: string | null,
  contactId?: string | null,
  ownership?: ChannelOwnership,
  status?: ChannelStatus,
): Promise<VideoChannel> {
  if (typeof contextOrTenantId !== 'string' && typeof platformOrData !== 'string') {
    const d = platformOrData
    return insertVideoChannelBase(
      (contextOrTenantId).tenantId,
      d.platform, d.platformChannelId,
      d.channelName ?? null, d.channelUrl ?? null,
      d.customerId ?? null, d.contactId ?? null,
      d.ownership ?? 'self', d.status ?? 'active',
    )
  }
  return insertVideoChannelBase(
    contextOrTenantId as string,
    platformOrData as VideoPlatform,
    platformChannelId!,
    channelName, channelUrl, customerId, contactId,
    ownership, status,
  )
}

export async function getVideoChannelById(
  tenantId: string,
  id: string,
): Promise<VideoChannel | null> {
  return queryRow<VideoChannel>(
    `SELECT * FROM video_channels WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  )
}

/** Context-accepting alias used by the API routers. */
export async function queryVideoChannel(
  context: TenantRequestContext,
  id: string,
): Promise<VideoChannel | null> {
  return getVideoChannelById(context.tenantId, id)
}

export async function getVideoChannelByPlatformId(
  tenantId: string,
  platform: VideoPlatform,
  platformChannelId: string,
): Promise<VideoChannel | null> {
  return queryRow<VideoChannel>(
    `SELECT * FROM video_channels
      WHERE tenant_id = $1 AND platform = $2 AND platform_channel_id = $3
      LIMIT 1`,
    [tenantId, platform, platformChannelId],
  )
}

export interface ChannelFilters {
  platform?: VideoPlatform
  status?: ChannelStatus
  ownership?: ChannelOwnership
  customerId?: string
}

/** Alias kept for backward-compat with the API router import. */
export type VideoChannelFilters = ChannelFilters

export async function listVideoChannels(
  tenantId: string,
  filters: ChannelFilters = {},
): Promise<VideoChannel[]> {
  const conditions: string[] = ['tenant_id = $1']
  const params: unknown[] = [tenantId]
  let idx = 1

  if (filters.platform) {
    idx++
    conditions.push(`platform = $${idx}`)
    params.push(filters.platform)
  }
  if (filters.status) {
    idx++
    conditions.push(`status = $${idx}`)
    params.push(filters.status)
  }
  if (filters.ownership) {
    idx++
    conditions.push(`ownership = $${idx}`)
    params.push(filters.ownership)
  }
  if (filters.customerId) {
    idx++
    conditions.push(`customer_id = $${idx}`)
    params.push(filters.customerId)
  }

  return queryRows<VideoChannel>(
    `SELECT * FROM video_channels WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    params,
  )
}

/** Paged list used by `GET /api/video/channels`. */
export async function queryVideoChannelsPage(
  context: TenantRequestContext,
  filters: ChannelFilters,
  page: ListPage,
): Promise<ListResult<VideoChannel>> {
  const conditions: string[] = ['tenant_id = $1']
  const params: unknown[] = [context.tenantId]
  let idx = 1

  if (filters.platform) {
    idx++
    conditions.push(`platform = $${idx}`)
    params.push(filters.platform)
  }
  if (filters.status) {
    idx++
    conditions.push(`status = $${idx}`)
    params.push(filters.status)
  }
  if (filters.ownership) {
    idx++
    conditions.push(`ownership = $${idx}`)
    params.push(filters.ownership)
  }
  if (filters.customerId) {
    idx++
    conditions.push(`customer_id = $${idx}`)
    params.push(filters.customerId)
  }

  const where = conditions.join(' AND ')

  const counts = await queryRows<{ count: number }>(
    `SELECT count(*)::int AS count FROM video_channels WHERE ${where}`,
    params,
  )

  idx++
  const limitIdx = idx
  idx++
  const offsetIdx = idx

  const items = await queryRows<VideoChannel>(
    `SELECT * FROM video_channels WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...params, page.limit, page.offset],
  )

  return { items, total: counts[0]?.count ?? 0 }
}

export interface VideoChannelUpdates {
  channelName?: string
  channelUrl?: string | null
  status?: ChannelStatus
  oauthTokenId?: string | null
  lastSyncAt?: Date | string
}

/**
 * Update a video channel.
 *
 * Accepts either `updateVideoChannel(tenantId, id, updates)` or the
 * context-aware form `updateVideoChannel(context, id, updates)`.
 */
export async function updateVideoChannel(
  contextOrTenantId: TenantRequestContext | string,
  id: string,
  updates: VideoChannelUpdates,
): Promise<VideoChannel | null> {
  const tenantId = typeof contextOrTenantId === 'string'
    ? contextOrTenantId
    : contextOrTenantId.tenantId

  const sets: string[] = []
  const params: unknown[] = [tenantId, id]
  let idx = 2

  if (updates.channelName !== undefined) {
    idx++
    sets.push(`channel_name = $${idx}`)
    params.push(updates.channelName)
  }
  if (updates.channelUrl !== undefined) {
    idx++
    sets.push(`channel_url = $${idx}`)
    params.push(updates.channelUrl)
  }
  if (updates.status !== undefined) {
    idx++
    sets.push(`status = $${idx}`)
    params.push(updates.status)
  }
  if (updates.oauthTokenId !== undefined) {
    idx++
    sets.push(`oauth_token_id = $${idx}`)
    params.push(updates.oauthTokenId)
  }
  if (updates.lastSyncAt !== undefined) {
    idx++
    sets.push(`last_sync_at = $${idx}`)
    params.push(updates.lastSyncAt)
  }

  if (sets.length === 0) {
    return getVideoChannelById(tenantId, id)
  }

  sets.push('updated_at = now()')

  return queryRow<VideoChannel>(
    `UPDATE video_channels SET ${sets.join(', ')}
      WHERE id = $2 AND tenant_id = $1
      RETURNING *`,
    params,
  )
}

/**
 * Delete a video channel.
 *
 * Accepts either `deleteVideoChannel(tenantId, id)` or the context-aware
 * form `deleteVideoChannel(context, id)`.
 */
export async function deleteVideoChannel(
  contextOrTenantId: TenantRequestContext | string,
  id: string,
): Promise<boolean> {
  const tenantId = typeof contextOrTenantId === 'string'
    ? contextOrTenantId
    : contextOrTenantId.tenantId

  const result = await getDbClient().query(
    `DELETE FROM video_channels WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [id, tenantId],
  )
  return (result.rowCount ?? 0) > 0
}

/** Clear the oauth_token_id reference on a channel (disconnect flow). */
export async function clearChannelOAuthToken(
  context: TenantRequestContext,
  channelId: string,
): Promise<void> {
  await getDbClient().query(
    `UPDATE video_channels SET oauth_token_id = NULL, updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [channelId, context.tenantId],
  )
}

// ═══════════════════════════════════════════════════════════════════════════
//  oauth_tokens
// ═══════════════════════════════════════════════════════════════════════════

export interface InsertOAuthTokenData {
  platform: VideoPlatform
  refreshTokenEnc: string
  accessTokenEnc?: string | null
  tokenExpiresAt?: string | Date | null
  scopes?: string | null
}

/**
 * Insert an OAuth token.
 *
 * Calling convention: insertOAuthToken(tenantId, { platform, refreshTokenEnc, ... })
 */
export async function insertOAuthToken(
  tenantId: string,
  data: InsertOAuthTokenData,
): Promise<OAuthToken> {
  const row = await queryRow<OAuthToken>(
    `INSERT INTO oauth_tokens
       (tenant_id, platform, access_token_enc, refresh_token_enc,
        expires_at, scope)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [tenantId, data.platform, data.accessTokenEnc ?? null, data.refreshTokenEnc,
     data.tokenExpiresAt ?? null, data.scopes ?? null],
  )
  if (!row) throw new Error('oauth_tokens insert returned no row')
  return row
}

export async function getOAuthTokenById(
  tenantId: string,
  id: string,
): Promise<OAuthToken | null> {
  return queryRow<OAuthToken>(
    `SELECT * FROM oauth_tokens WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  )
}

/** Alias used by the OAuth disconnect flow. */
export const queryOAuthTokenById = getOAuthTokenById

export async function getLatestOAuthToken(
  tenantId: string,
  platform: VideoPlatform,
): Promise<OAuthToken | null> {
  return queryRow<OAuthToken>(
    `SELECT * FROM oauth_tokens
      WHERE tenant_id = $1 AND platform = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId, platform],
  )
}

export interface OAuthTokenUpdates {
  accessTokenEnc?: string
  refreshTokenEnc?: string
  expiresAt?: Date | string
  scopes?: string
}

export async function updateOAuthToken(
  tenantId: string,
  id: string,
  updates: OAuthTokenUpdates,
): Promise<OAuthToken | null> {
  const sets: string[] = []
  const params: unknown[] = [tenantId, id]
  let idx = 2

  if (updates.accessTokenEnc !== undefined) {
    idx++
    sets.push(`access_token_enc = $${idx}`)
    params.push(updates.accessTokenEnc)
  }
  if (updates.refreshTokenEnc !== undefined) {
    idx++
    sets.push(`refresh_token_enc = $${idx}`)
    params.push(updates.refreshTokenEnc)
  }
  if (updates.expiresAt !== undefined) {
    idx++
    sets.push(`expires_at = $${idx}`)
    params.push(updates.expiresAt)
  }
  if (updates.scopes !== undefined) {
    idx++
    sets.push(`scope = $${idx}`)
    params.push(updates.scopes)
  }

  if (sets.length === 0) {
    return getOAuthTokenById(tenantId, id)
  }

  sets.push('updated_at = now()')

  return queryRow<OAuthToken>(
    `UPDATE oauth_tokens SET ${sets.join(', ')}
      WHERE id = $2 AND tenant_id = $1
      RETURNING *`,
    params,
  )
}

/**
 * Delete an OAuth token.
 *
 * Accepts either `deleteOAuthToken(tenantId, id)` or the context-aware
 * form `deleteOAuthToken(context, id)`.
 */
export async function deleteOAuthToken(
  contextOrTenantId: TenantRequestContext | string,
  id: string,
): Promise<boolean> {
  const tenantId = typeof contextOrTenantId === 'string'
    ? contextOrTenantId
    : contextOrTenantId.tenantId

  const result = await getDbClient().query(
    `DELETE FROM oauth_tokens WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [id, tenantId],
  )
  return (result.rowCount ?? 0) > 0
}

// ═══════════════════════════════════════════════════════════════════════════
//  video_earnings
// ═══════════════════════════════════════════════════════════════════════════

export async function insertVideoEarning(
  tenantId: string,
  channelId: string,
  date: Date | string,
  estimatedEarnings?: number | null,
  currency?: string | null,
  adRevenue?: number | null,
  cpm?: number | null,
  rpm?: number | null,
  viewsCount?: number | null,
  metadata?: Record<string, unknown> | null,
): Promise<VideoEarning> {
  const row = await queryRow<VideoEarning>(
    `INSERT INTO video_earnings
       (tenant_id, channel_id, date, estimated_earnings, currency,
        ad_revenue, cpm, rpm, views_count, metadata)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING *`,
    [tenantId, channelId, date,
     estimatedEarnings ?? null, currency ?? null,
     adRevenue ?? null, cpm ?? null, rpm ?? null,
     viewsCount ?? null,
     metadata ? JSON.stringify(metadata) : null],
  )
  if (!row) throw new Error('video_earnings insert returned no row')
  return row
}

export async function getVideoEarningsByChannel(
  tenantId: string,
  channelId: string,
  dateRange?: { start: Date | string; end: Date | string },
): Promise<VideoEarning[]> {
  const conditions: string[] = ['tenant_id = $1', 'channel_id = $2']
  const params: unknown[] = [tenantId, channelId]
  let idx = 2

  if (dateRange) {
    idx++
    conditions.push(`date >= $${idx}::date`)
    params.push(dateRange.start)
    idx++
    conditions.push(`date <= $${idx}::date`)
    params.push(dateRange.end)
  }

  return queryRows<VideoEarning>(
    `SELECT * FROM video_earnings
      WHERE ${conditions.join(' AND ')}
      ORDER BY date DESC`,
    params,
  )
}

export async function getVideoEarningsByDate(
  tenantId: string,
  date: Date | string,
): Promise<VideoEarning[]> {
  return queryRows<VideoEarning>(
    `SELECT * FROM video_earnings
      WHERE tenant_id = $1 AND date = $2::date
      ORDER BY channel_id`,
    [tenantId, date],
  )
}

export interface VideoEarningUpsert {
  estimatedEarnings?: number | null
  currency?: string | null
  adRevenue?: number | null
  cpm?: number | null
  rpm?: number | null
  viewsCount?: number | null
  metadata?: Record<string, unknown> | null
}

export async function upsertVideoEarning(
  tenantId: string,
  channelId: string,
  date: Date | string,
  updates: VideoEarningUpsert,
): Promise<VideoEarning> {
  const row = await queryRow<VideoEarning>(
    `INSERT INTO video_earnings
       (tenant_id, channel_id, date, estimated_earnings, currency,
        ad_revenue, cpm, rpm, views_count, metadata)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (tenant_id, channel_id, date) DO UPDATE SET
       estimated_earnings = EXCLUDED.estimated_earnings,
       currency           = EXCLUDED.currency,
       ad_revenue         = EXCLUDED.ad_revenue,
       cpm                = EXCLUDED.cpm,
       rpm                = EXCLUDED.rpm,
       views_count        = EXCLUDED.views_count,
       metadata           = EXCLUDED.metadata,
       updated_at         = now()
     RETURNING *`,
    [tenantId, channelId, date,
     updates.estimatedEarnings ?? null,
     updates.currency ?? null,
     updates.adRevenue ?? null,
     updates.cpm ?? null,
     updates.rpm ?? null,
     updates.viewsCount ?? null,
     updates.metadata ? JSON.stringify(updates.metadata) : null],
  )
  if (!row) throw new Error('video_earnings upsert returned no row')
  return row
}

export async function deleteVideoEarning(
  tenantId: string,
  id: string,
): Promise<boolean> {
  const result = await getDbClient().query(
    `DELETE FROM video_earnings WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [id, tenantId],
  )
  return (result.rowCount ?? 0) > 0
}

// ═══════════════════════════════════════════════════════════════════════════
//  video_audience_metrics
// ═══════════════════════════════════════════════════════════════════════════

export async function insertVideoAudienceMetric(
  tenantId: string,
  channelId: string,
  weekStart: Date | string,
  subscribersCount?: number | null,
  totalViews?: number | null,
  watchTimeMinutes?: number | null,
  engagementRate?: number | null,
  metadata?: Record<string, unknown> | null,
): Promise<VideoAudienceMetric> {
  const row = await queryRow<VideoAudienceMetric>(
    `INSERT INTO video_audience_metrics
       (tenant_id, channel_id, week_start, subscribers_count,
        total_views, watch_time_minutes, engagement_rate, metadata)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8::jsonb)
     RETURNING *`,
    [tenantId, channelId, weekStart,
     subscribersCount ?? null, totalViews ?? null,
     watchTimeMinutes ?? null, engagementRate ?? null,
     metadata ? JSON.stringify(metadata) : null],
  )
  if (!row) throw new Error('video_audience_metrics insert returned no row')
  return row
}

export async function getVideoAudienceMetricsByChannel(
  tenantId: string,
  channelId: string,
  dateRange?: { start: Date | string; end: Date | string },
): Promise<VideoAudienceMetric[]> {
  const conditions: string[] = ['tenant_id = $1', 'channel_id = $2']
  const params: unknown[] = [tenantId, channelId]
  let idx = 2

  if (dateRange) {
    idx++
    conditions.push(`week_start >= $${idx}::date`)
    params.push(dateRange.start)
    idx++
    conditions.push(`week_start <= $${idx}::date`)
    params.push(dateRange.end)
  }

  return queryRows<VideoAudienceMetric>(
    `SELECT * FROM video_audience_metrics
      WHERE ${conditions.join(' AND ')}
      ORDER BY week_start DESC`,
    params,
  )
}

export interface VideoAudienceMetricUpsert {
  subscribersCount?: number | null
  totalViews?: number | null
  watchTimeMinutes?: number | null
  engagementRate?: number | null
  metadata?: Record<string, unknown> | null
}

export async function upsertVideoAudienceMetric(
  tenantId: string,
  channelId: string,
  weekStart: Date | string,
  updates: VideoAudienceMetricUpsert,
): Promise<VideoAudienceMetric> {
  const row = await queryRow<VideoAudienceMetric>(
    `INSERT INTO video_audience_metrics
       (tenant_id, channel_id, week_start, subscribers_count,
        total_views, watch_time_minutes, engagement_rate, metadata)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (tenant_id, channel_id, week_start) DO UPDATE SET
       subscribers_count  = EXCLUDED.subscribers_count,
       total_views        = EXCLUDED.total_views,
       watch_time_minutes = EXCLUDED.watch_time_minutes,
       engagement_rate    = EXCLUDED.engagement_rate,
       metadata           = EXCLUDED.metadata,
       updated_at         = now()
     RETURNING *`,
    [tenantId, channelId, weekStart,
     updates.subscribersCount ?? null,
     updates.totalViews ?? null,
     updates.watchTimeMinutes ?? null,
     updates.engagementRate ?? null,
     updates.metadata ? JSON.stringify(updates.metadata) : null],
  )
  if (!row) throw new Error('video_audience_metrics upsert returned no row')
  return row
}

export async function deleteVideoAudienceMetric(
  tenantId: string,
  id: string,
): Promise<boolean> {
  const result = await getDbClient().query(
    `DELETE FROM video_audience_metrics WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [id, tenantId],
  )
  return (result.rowCount ?? 0) > 0
}
