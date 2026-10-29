// tests/unit/video/scheduling.test.ts
// Unit coverage for the video sync scheduler in
// src/mastra/schedules/video-sync.ts.
//
// The scheduler now writes through the real DB query layer, so the whole
// `src/db/video-queries` module is stubbed here (same pattern as
// youtube-adapter.test.ts) — no pg pool or env plumbing loads at import time.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const db = vi.hoisted(() => ({
  listVideoChannels: vi.fn(),
  updateVideoChannel: vi.fn().mockResolvedValue({}),
  upsertVideoEarning: vi.fn().mockResolvedValue({}),
  upsertVideoAudienceMetric: vi.fn().mockResolvedValue({}),
  // ensureAdaptersRegistered() builds real TikTok/Instagram/Twitch adapters
  // whose default deps reference these token helpers. Construction only stores
  // the references (the revenue-less platforms are skipped before any fetch),
  // but the mocked module must still export them or the mock throws on access.
  getOAuthTokenById: vi.fn(),
  getLatestOAuthToken: vi.fn(),
  updateOAuthToken: vi.fn(),
}))
vi.mock('../../../src/db/video-queries', () => db)

import {
  buildDailyEarningsScheduleConfig,
  buildWeeklyAudienceScheduleConfig,
  buildVideoSyncScheduleConfigs,
  runDailyEarningsSync,
  runWeeklyAudienceSync,
  registerAdapter,
  mondayOf,
  type VideoChannel,
} from '../../../src/mastra/schedules/video-sync'
import { BasePlatformAdapter } from '../../../src/video/platform-adapters/base'
import type { DateRange, EarningsData, AudienceData } from '../../../src/video/platform-adapters'
import type { CrumEnv } from '../../../src/config/env'

// Minimal typed env; the schedule only needs it to build the YouTube adapter,
// and a mock adapter is registered under 'youtube' before every run.
function envFixture(): CrumEnv {
  return { NODE_ENV: 'test' } as unknown as CrumEnv
}

function channelFixture(overrides: Partial<VideoChannel> & Pick<VideoChannel, 'id' | 'platform'>): VideoChannel {
  return {
    tenant_id: 'tenant-1',
    platform_channel_id: 'UC-abc',
    channel_name: 'Test Channel',
    channel_url: null,
    customer_id: null,
    contact_id: null,
    ownership: 'self',
    status: 'active',
    oauth_token_id: 'tok-1',
    last_sync_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Schedule definition tests
// ---------------------------------------------------------------------------

describe('video sync schedule definitions', () => {
  it('dailyEarningsSync has correct cron and id', () => {
    const config = buildDailyEarningsScheduleConfig()
    expect(config.id).toBe('video-daily-earnings-sync')
    expect(config.workflowId).toBe('video-daily-earnings')
    expect(config.cron).toBe('0 2 * * *')
    expect(config.timezone).toBe('UTC')
  })

  it('weeklyAudienceSync has correct cron and id', () => {
    const config = buildWeeklyAudienceScheduleConfig()
    expect(config.id).toBe('video-weekly-audience-sync')
    expect(config.workflowId).toBe('video-weekly-audience')
    expect(config.cron).toBe('0 3 * * 1')
    expect(config.timezone).toBe('UTC')
  })

  it('buildVideoSyncScheduleConfigs returns both schedules', () => {
    const configs = buildVideoSyncScheduleConfigs()
    expect(configs).toHaveLength(2)
    expect(configs.map((c) => c.id)).toEqual([
      'video-daily-earnings-sync',
      'video-weekly-audience-sync',
    ])
  })
})

// ---------------------------------------------------------------------------
// Monday bucketing helper
// ---------------------------------------------------------------------------

describe('mondayOf', () => {
  it('returns the same Monday for a Monday', () => {
    expect(mondayOf('2026-10-26')).toBe('2026-10-26') // Monday
  })

  it('rolls a Sunday back to the previous Monday', () => {
    expect(mondayOf('2026-11-01')).toBe('2026-10-26') // Sunday
  })

  it('rolls any mid-week day back to its Monday', () => {
    expect(mondayOf('2026-10-30')).toBe('2026-10-26') // Friday
  })

  it('returns unparseable input unchanged', () => {
    expect(mondayOf('not-a-date')).toBe('not-a-date')
  })
})

// ---------------------------------------------------------------------------
// BasePlatformAdapter tests
// ---------------------------------------------------------------------------

describe('BasePlatformAdapter', () => {
  class TestAdapter extends BasePlatformAdapter {
    readonly platform = 'test-platform'
  }

  let adapter: TestAdapter

  beforeEach(() => {
    adapter = new TestAdapter()
  })

  it('fetchEarnings throws "not implemented"', async () => {
    const range: DateRange = { start: '2026-01-01', end: '2026-01-02' }
    await expect(adapter.fetchEarnings('ch-1', range)).rejects.toThrow(
      '[test-platform] fetchEarnings is not implemented',
    )
  })

  it('fetchAudienceMetrics throws "not implemented"', async () => {
    const range: DateRange = { start: '2026-01-01', end: '2026-01-02' }
    await expect(adapter.fetchAudienceMetrics('ch-1', range)).rejects.toThrow(
      '[test-platform] fetchAudienceMetrics is not implemented',
    )
  })

  it('refreshOAuthToken throws "not implemented"', async () => {
    await expect(adapter.refreshOAuthToken('tok-1')).rejects.toThrow(
      '[test-platform] refreshOAuthToken is not implemented',
    )
  })
})

// ---------------------------------------------------------------------------
// Sync logic tests with mock adapter
// ---------------------------------------------------------------------------

describe('runDailyEarningsSync', () => {
  const mockChannels: VideoChannel[] = [
    channelFixture({ id: 'vc-1', platform: 'youtube', platform_channel_id: 'UC-abc' }),
    channelFixture({
      id: 'vc-2',
      platform: 'tiktok',
      platform_channel_id: 'TT-xyz',
      oauth_token_id: 'tok-2',
    }),
  ]

  const mockQueryChannels = vi.fn().mockResolvedValue(mockChannels)

  class MockYouTubeAdapter extends BasePlatformAdapter {
    readonly platform = 'youtube'

    override async fetchEarnings(channelId: string, dateRange: DateRange): Promise<EarningsData> {
      return {
        channelId,
        platform: 'youtube',
        dateRange,
        records: [
          {
            date: dateRange.start,
            revenue_micros: 1500000,
            currency: 'USD',
            impressions: 5000,
            estimated_revenue: 1.5,
          },
        ],
        fetchedAt: new Date().toISOString(),
      }
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    registerAdapter('youtube', new MockYouTubeAdapter())
  })

  it('upserts earnings rows for revenue-capable channels and skips revenue-less ones', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await runDailyEarningsSync('tenant-1', envFixture(), mockQueryChannels)

    expect(mockQueryChannels).toHaveBeenCalledWith('tenant-1')
    expect(result.processed).toBe(1) // youtube adapter exists
    // TikTok's adapter is auto-registered by ensureAdaptersRegistered but
    // reports supportsRevenue=false, so it is skipped (not an error).
    expect(result.errors).toBe(0)
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Skipping earnings for channel TT-xyz on tiktok'),
    )
    expect(db.upsertVideoEarning).toHaveBeenCalledWith(
      'tenant-1',
      'vc-1',
      expect.any(String),
      expect.objectContaining({
        estimatedEarnings: 1.5,
        currency: 'USD',
        viewsCount: 5000,
      }),
    )
    expect(db.updateVideoChannel).toHaveBeenCalledWith('tenant-1', 'vc-1', {
      lastSyncAt: expect.any(String),
    })
    logSpy.mockRestore()
  })

  it('reports error for channels whose platform has no adapter', async () => {
    // All four known platforms are auto-registered by ensureAdaptersRegistered,
    // so the "no adapter" branch is only reachable for an unknown/legacy
    // platform value stored in a video_channels row.
    const legacyChannels: VideoChannel[] = [
      channelFixture({
        id: 'vc-unknown',
        platform: 'vimeo' as VideoChannel['platform'],
        platform_channel_id: 'V-1',
      }),
    ]
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await runDailyEarningsSync(
      'tenant-1',
      envFixture(),
      vi.fn().mockResolvedValue(legacyChannels),
    )

    expect(result.errors).toBe(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No adapter registered for platform "vimeo"'),
    )
    warnSpy.mockRestore()
  })

  it('handles adapter errors gracefully', async () => {
    class FailingAdapter extends BasePlatformAdapter {
      readonly platform = 'twitch'
      override async fetchEarnings(): Promise<EarningsData> {
        throw new Error('API rate limit exceeded')
      }
    }

    const failingChannels: VideoChannel[] = [
      channelFixture({
        id: 'vc-fail',
        platform: 'twitch',
        platform_channel_id: 'UC-fail',
        oauth_token_id: null,
      }),
    ]
    registerAdapter('twitch', new FailingAdapter())

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await runDailyEarningsSync(
      'tenant-1',
      envFixture(),
      vi.fn().mockResolvedValue(failingChannels),
    )

    expect(result.processed).toBe(0)
    expect(result.errors).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to sync earnings for channel UC-fail'),
      expect.any(String),
    )
    errorSpy.mockRestore()
  })
})

describe('runWeeklyAudienceSync', () => {
  const mockChannels: VideoChannel[] = [
    channelFixture({ id: 'vc-1', platform: 'youtube', platform_channel_id: 'UC-abc' }),
  ]

  class MockYouTubeAdapter extends BasePlatformAdapter {
    readonly platform = 'youtube'

    override async fetchAudienceMetrics(
      channelId: string,
      dateRange: DateRange,
    ): Promise<AudienceData> {
      return {
        channelId,
        platform: 'youtube',
        dateRange,
        records: [
          {
            date: dateRange.start,
            views: 10000,
            watchTimeMinutes: 50000,
            subscribersGained: 50,
            subscribersLost: 5,
            likes: 500,
            comments: 100,
            shares: 50,
          },
        ],
        fetchedAt: new Date().toISOString(),
      }
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    registerAdapter('youtube', new MockYouTubeAdapter())
  })

  it('aggregates records into a weekly upsert', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = await runWeeklyAudienceSync(
      'tenant-1',
      envFixture(),
      vi.fn().mockResolvedValue(mockChannels),
    )

    expect(result.processed).toBe(1)
    expect(result.errors).toBe(0)
    expect(db.upsertVideoAudienceMetric).toHaveBeenCalledWith(
      'tenant-1',
      'vc-1',
      expect.any(String),
      expect.objectContaining({
        subscribersCount: 45,
        totalViews: 10000,
        watchTimeMinutes: 50000,
      }),
    )
    logSpy.mockRestore()
  })

  it('handles empty channel list', async () => {
    const result = await runWeeklyAudienceSync(
      'tenant-1',
      envFixture(),
      vi.fn().mockResolvedValue([]),
    )
    expect(result.processed).toBe(0)
    expect(result.errors).toBe(0)
  })
})
