import type { CreateWorkflowScheduleInput } from '@mastra/core/schedules'

// ---------------------------------------------------------------------------
// Imports (DB layer, env, platform adapters)
// ---------------------------------------------------------------------------

import type { CrumEnv } from '../../config/env'
import type { VideoChannel } from '../../db/types'
import {
  listVideoChannels,
  updateVideoChannel,
  upsertVideoEarning,
  upsertVideoAudienceMetric,
} from '../../db/video-queries'
import type { PlatformAdapter, DateRange, EarningsData, AudienceRecord } from '../../video/platform-adapters'
import { createYoutubeAdapter } from '../../video/platform-adapters/youtube'
import { createTiktokAdapter } from '../../video/platform-adapters/tiktok'
import { createInstagramAdapter } from '../../video/platform-adapters/instagram'
import { createTwitchAdapter } from '../../video/platform-adapters/twitch'

// Re-export so existing consumers (schedule tests, boot wiring) keep a single
// import site; the row type itself now comes from the real DB schema.
export type { VideoChannel } from '../../db/types'

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function yesterdayRange(): DateRange {
  return { start: daysAgo(1), end: todayISO() }
}

function lastWeekRange(): DateRange {
  return { start: daysAgo(7), end: todayISO() }
}

/**
 * Monday of the ISO week containing `dateISO` (YYYY-MM-DD). Parsed as UTC so
 * local timezones cannot shift the bucket boundary; anything unparseable is
 * returned unchanged (the DB cast will surface the real error).
 */
export function mondayOf(dateISO: string): string {
  const d = new Date(`${dateISO}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return dateISO
  const day = d.getUTCDay() // 0 = Sunday … 6 = Saturday
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day))
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

const adapters = new Map<string, PlatformAdapter>()

export function registerAdapter(platform: string, adapter: PlatformAdapter): void {
  adapters.set(platform, adapter)
}

export function getAdapter(platform: string): PlatformAdapter | undefined {
  return adapters.get(platform)
}

/** Every platform whose adapter can be built from `(env, tenantId)`. */
type AdapterFactory = (env: CrumEnv, tenantId: string) => PlatformAdapter

const adapterFactories: Record<string, AdapterFactory> = {
  youtube: createYoutubeAdapter,
  tiktok: createTiktokAdapter,
  instagram: createInstagramAdapter,
  twitch: createTwitchAdapter,
}

/**
 * Build and register the production adapter for `platform`.
 *
 * NOTE: the registry is keyed by platform, but every adapter resolves the
 * tenant's latest OAuth token from the tenantId it was constructed with. The
 * lazy {@link ensureAdaptersRegistered} below therefore binds the FIRST tenant
 * seen for each platform until that entry is replaced. TODO: key the registry
 * per (platform, tenantId) once multi-tenant scheduled runs land.
 */
export function registerPlatformAdapter(platform: string, env: CrumEnv, tenantId: string): void {
  const factory = adapterFactories[platform]
  if (factory) adapters.set(platform, factory(env, tenantId))
}

/** Back-compat alias for the original single-platform entry point. */
export function registerYoutubeAdapter(env: CrumEnv, tenantId: string): void {
  registerPlatformAdapter('youtube', env, tenantId)
}

/**
 * Register a production adapter for every known platform on demand, leaving any
 * already-registered entry (e.g. a test mock, or a first-tenant binding) alone.
 * `Map.set` is atomic, so this is safe for concurrent calls. Called at the top
 * of each sync run so schedules never depend on boot-time registration ordering.
 *
 * The daily earnings sync still skips TikTok/Instagram/Twitch because their
 * adapters report `supportsRevenue === false`; registering them here is what
 * lets the weekly audience sync actually pull their engagement data.
 */
export function ensureAdaptersRegistered(env: CrumEnv, tenantId: string): void {
  for (const platform of Object.keys(adapterFactories)) {
    if (!adapters.has(platform)) {
      registerPlatformAdapter(platform, env, tenantId)
    }
  }
}

/** @deprecated kept so existing call sites/tests keep compiling. */
export function ensureYoutubeRegistered(env: CrumEnv, tenantId: string): void {
  if (!adapters.has('youtube')) {
    registerYoutubeAdapter(env, tenantId)
  }
}

// ---------------------------------------------------------------------------
// Channel query (injectable for tests)
// ---------------------------------------------------------------------------

export type QueryActiveChannels = (tenantId: string) => Promise<VideoChannel[]>

async function defaultQueryActiveChannels(tenantId: string): Promise<VideoChannel[]> {
  return listVideoChannels(tenantId, { status: 'active' })
}

// ---------------------------------------------------------------------------
// Core sync logic
// ---------------------------------------------------------------------------

/**
 * Query all active video_channels for a tenant, fetch yesterday's earnings
 * from the platform adapter, and upsert each daily record into
 * `video_earnings`. Marks `video_channels.last_sync_at` on success.
 */
export async function runDailyEarningsSync(
  tenantId: string,
  env: CrumEnv,
  queryActiveChannels: QueryActiveChannels = defaultQueryActiveChannels,
): Promise<{ processed: number; errors: number }> {
  ensureAdaptersRegistered(env, tenantId)

  const channels = await queryActiveChannels(tenantId)
  let processed = 0
  let errors = 0
  const dateRange = yesterdayRange()

  for (const channel of channels) {
    const adapter = getAdapter(channel.platform)
    if (!adapter) {
      console.warn(
        `[video-sync] No adapter registered for platform "${channel.platform}" (channel ${channel.platform_channel_id})`,
      )
      errors++
      continue
    }

    // Platforms whose public API does not expose monetization data (TikTok,
    // Instagram, Twitch) are skipped here rather than failing. Their sponsorship
    // revenue is captured via the Phase 4 email-intake path, not the API.
    if (!adapter.supportsRevenue) {
      console.log(
        `[video-sync] Skipping earnings for channel ${channel.platform_channel_id} on ${channel.platform}: platform API exposes no revenue data`,
      )
      continue
    }

    try {
      const data: EarningsData = await adapter.fetchEarnings(channel.platform_channel_id, dateRange)

      for (const record of data.records) {
        // `estimated_earnings` is numeric, so map `estimated_revenue` (not
        // `revenue_micros`). `viewsCount` maps from `record.impressions` —
        // the DB layer accepts it, and the YouTube adapter already reports
        // channel views there as its impressions proxy.
        // NOTE: ad_revenue/cpm/rpm stay null: the shared EarningsRecord
        // contract does not carry those fields.
        await upsertVideoEarning(tenantId, channel.id, record.date, {
          estimatedEarnings: record.estimated_revenue,
          currency: record.currency,
          viewsCount: record.impressions,
          metadata: {
            platform: data.platform,
            revenue_micros: record.revenue_micros,
            fetched_at: data.fetchedAt,
          },
        })
      }

      await updateVideoChannel(tenantId, channel.id, {
        lastSyncAt: new Date().toISOString(),
      })

      console.log(
        `[video-sync] Synced ${data.records.length} earnings row(s) for channel ${channel.platform_channel_id} on ${channel.platform} (${dateRange.start} to ${dateRange.end})`,
      )
      processed++
    } catch (err) {
      console.error(
        `[video-sync] Failed to sync earnings for channel ${channel.platform_channel_id}:`,
        err instanceof Error ? err.message : String(err),
      )
      errors++
    }
  }

  return { processed, errors }
}

/** Per-week accumulator for audience records (one row per week_start). */
interface WeekBucket {
  totalViews: number
  watchTimeMinutes: number
  netSubscribers: number
  perVideo: unknown[]
}

/**
 * Query all active video_channels for a tenant, fetch the last week's audience
 * metrics from the platform adapter, aggregate the daily records into one row
 * per (channel, week_start) — Monday-anchored — and upsert into
 * `video_audience_metrics`. Marks `video_channels.last_sync_at` on success.
 */
export async function runWeeklyAudienceSync(
  tenantId: string,
  env: CrumEnv,
  queryActiveChannels: QueryActiveChannels = defaultQueryActiveChannels,
): Promise<{ processed: number; errors: number }> {
  ensureAdaptersRegistered(env, tenantId)

  const channels = await queryActiveChannels(tenantId)
  let processed = 0
  let errors = 0
  const dateRange = lastWeekRange()

  for (const channel of channels) {
    const adapter = getAdapter(channel.platform)
    if (!adapter) {
      console.warn(
        `[video-sync] No adapter registered for platform "${channel.platform}" (channel ${channel.platform_channel_id})`,
      )
      errors++
      continue
    }

    if (!adapter.supportsAudienceMetrics) {
      console.log(
        `[video-sync] Skipping audience metrics for channel ${channel.platform_channel_id} on ${channel.platform}: platform exposes no audience data`,
      )
      continue
    }

    try {
      const data = await adapter.fetchAudienceMetrics(channel.platform_channel_id, dateRange)

      // Aggregate the adapter's daily records into one row per ISO week.
      const weeks = new Map<string, WeekBucket>()
      for (const record of data.records) {
        const weekStart = mondayOf(record.date)
        let bucket = weeks.get(weekStart)
        if (!bucket) {
          bucket = { totalViews: 0, watchTimeMinutes: 0, netSubscribers: 0, perVideo: [] }
          weeks.set(weekStart, bucket)
        }
        bucket.totalViews += record.views
        bucket.watchTimeMinutes += record.watchTimeMinutes
        bucket.netSubscribers += record.subscribersGained - record.subscribersLost

        // The YouTube adapter may attach a `_perVideo` breakdown to each
        // daily record (see YoutubeAudienceRecord in platform-adapters/
        // youtube.ts); persist it in the week's metadata jsonb.
        const withPerVideo = record as AudienceRecord & { _perVideo?: unknown[] }
        if (withPerVideo._perVideo && withPerVideo._perVideo.length > 0) {
          bucket.perVideo.push(...withPerVideo._perVideo)
        }
      }

      for (const [weekStart, bucket] of weeks) {
        await upsertVideoAudienceMetric(tenantId, channel.id, weekStart, {
          subscribersCount: bucket.netSubscribers,
          totalViews: bucket.totalViews,
          watchTimeMinutes: bucket.watchTimeMinutes,
          // TODO(engagement): engagement_rate is decimal(5,4) and needs an
          // interaction denominator (likes/comments/shares over views); the
          // adapter reports no interaction counts for channel queries, so we
          // store null until the denominator is available.
          engagementRate: null,
          metadata: bucket.perVideo.length > 0
            ? { per_video: bucket.perVideo, date_range: data.dateRange, fetched_at: data.fetchedAt }
            : null,
        })
      }

      await updateVideoChannel(tenantId, channel.id, {
        lastSyncAt: new Date().toISOString(),
      })

      console.log(
        `[video-sync] Synced ${weeks.size} weekly audience row(s) for channel ${channel.platform_channel_id} on ${channel.platform} (${dateRange.start} to ${dateRange.end})`,
      )
      processed++
    } catch (err) {
      console.error(
        `[video-sync] Failed to sync audience metrics for channel ${channel.platform_channel_id}:`,
        err instanceof Error ? err.message : String(err),
      )
      errors++
    }
  }

  return { processed, errors }
}

// ---------------------------------------------------------------------------
// Schedule config builders (follow the digest schedule pattern)
// ---------------------------------------------------------------------------

export function buildDailyEarningsScheduleConfig(): CreateWorkflowScheduleInput {
  return {
    id: 'video-daily-earnings-sync',
    workflowId: 'video-daily-earnings',
    cron: '0 2 * * *', // daily at 2:00 AM UTC
    timezone: 'UTC',
  }
}

export function buildWeeklyAudienceScheduleConfig(): CreateWorkflowScheduleInput {
  return {
    id: 'video-weekly-audience-sync',
    workflowId: 'video-weekly-audience',
    cron: '0 3 * * 1', // weekly on Monday at 3:00 AM UTC
    timezone: 'UTC',
  }
}

/**
 * Build all video sync schedule configs. Returns an array so the boot
 * sequence can register each one with `mastra.schedules.create()`.
 */
export function buildVideoSyncScheduleConfigs(): CreateWorkflowScheduleInput[] {
  return [
    buildDailyEarningsScheduleConfig(),
    buildWeeklyAudienceScheduleConfig(),
  ]
}
