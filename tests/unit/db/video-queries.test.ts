import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'

// ── shared mock plumbing (mirrors tests/db/queries.test.ts) ────────────────

const mockQuery = vi.fn()
const mockEnd = vi.fn()
const mockPool = {
  query: mockQuery,
  end: mockEnd,
} as unknown as Pool

vi.mock('pg', () => ({
  Pool: vi.fn(() => mockPool),
}))

vi.mock('../../../src/config/env', () => ({
  parseEnv: () => ({
    DATABASE_URL: 'postgres://test:test@localhost:5432/testdb',
    NODE_ENV: 'test',
  }),
}))

const TENANT = 'tenant-1'
const OTHER_TENANT = 'tenant-2'
const USER = 'user-1'

// helper: extract the SQL string from the first (or nth) mock call
function sqlAt(callIndex = 0): string {
  return mockQuery.mock.calls[callIndex]![0] as string
}

function paramsAt(callIndex = 0): unknown[] {
  return mockQuery.mock.calls[callIndex]![1] as unknown[]
}

// ═══════════════════════════════════════════════════════════════════════════
//  video_channels
// ═══════════════════════════════════════════════════════════════════════════

describe('video_channels – insertVideoChannel', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('inserts with required fields and returns the created row', async () => {
    const created = {
      id: 'vc1', tenant_id: TENANT, platform: 'youtube',
      platform_channel_id: 'UC123', channel_name: null, channel_url: null,
      customer_id: null, contact_id: null, ownership: 'self',
      status: 'active', oauth_token_id: null, last_sync_at: null,
      created_at: '2026-01-01', updated_at: '2026-01-01',
    }
    mockQuery.mockResolvedValueOnce({ rows: [created] })

    const { insertVideoChannel } = await import('../../../src/db/video-queries')
    const result = await insertVideoChannel(TENANT, 'youtube', 'UC123')

    expect(result).toEqual(created)
    expect(sqlAt()).toContain('INSERT INTO video_channels')
    expect(sqlAt()).toContain('RETURNING *')
    expect(paramsAt()[0]).toBe(TENANT)
    expect(paramsAt()[1]).toBe('youtube')
    expect(paramsAt()[2]).toBe('UC123')
  })

  it('passes optional fields when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'vc2' }] })

    const { insertVideoChannel } = await import('../../../src/db/video-queries')
    await insertVideoChannel(
      TENANT, 'tiktok', 'TT456', 'My Channel',
      'https://tiktok.com/@my', 'cust-1', 'contact-1',
      'client', 'disconnected',
    )

    const p = paramsAt()
    expect(p[3]).toBe('My Channel')
    expect(p[4]).toBe('https://tiktok.com/@my')
    expect(p[5]).toBe('cust-1')
    expect(p[6]).toBe('contact-1')
    expect(p[7]).toBe('client')
    expect(p[8]).toBe('disconnected')
  })
})

describe('video_channels – getVideoChannelById', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('returns the row when found', async () => {
    const row = { id: 'vc1', tenant_id: TENANT, platform: 'youtube' }
    mockQuery.mockResolvedValueOnce({ rows: [row] })

    const { getVideoChannelById } = await import('../../../src/db/video-queries')
    const result = await getVideoChannelById(TENANT, 'vc1')

    expect(result).toEqual(row)
    expect(sqlAt()).toContain('id = $1')
    expect(sqlAt()).toContain('tenant_id = $2')
    expect(paramsAt()).toEqual(['vc1', TENANT])
  })

  it('returns null when not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { getVideoChannelById } = await import('../../../src/db/video-queries')
    const result = await getVideoChannelById(TENANT, 'missing')

    expect(result).toBeNull()
  })
})

describe('video_channels – getVideoChannelByPlatformId', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('filters by tenant, platform, and platform_channel_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'vc1' }] })

    const { getVideoChannelByPlatformId } = await import('../../../src/db/video-queries')
    const result = await getVideoChannelByPlatformId(TENANT, 'youtube', 'UC123')

    expect(result).toEqual({ id: 'vc1' })
    expect(sqlAt()).toContain('tenant_id = $1')
    expect(sqlAt()).toContain('platform = $2')
    expect(sqlAt()).toContain('platform_channel_id = $3')
    expect(paramsAt()).toEqual([TENANT, 'youtube', 'UC123'])
  })
})

describe('video_channels – listVideoChannels', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('returns all channels for a tenant when no filters', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'vc1' }, { id: 'vc2' }] })

    const { listVideoChannels } = await import('../../../src/db/video-queries')
    const result = await listVideoChannels(TENANT)

    expect(result).toHaveLength(2)
    expect(sqlAt()).toContain('tenant_id = $1')
    expect(sqlAt()).not.toContain('platform =')
    expect(paramsAt()).toEqual([TENANT])
  })

  it('applies all filters dynamically', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { listVideoChannels } = await import('../../../src/db/video-queries')
    await listVideoChannels(TENANT, {
      platform: 'twitch',
      status: 'active',
      ownership: 'self',
      customerId: 'cust-1',
    })

    const sql = sqlAt()
    expect(sql).toContain('platform = $2')
    expect(sql).toContain('status = $3')
    expect(sql).toContain('ownership = $4')
    expect(sql).toContain('customer_id = $5')
    expect(paramsAt()).toEqual([TENANT, 'twitch', 'active', 'self', 'cust-1'])
  })
})

describe('video_channels – updateVideoChannel', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('builds SET clause dynamically and filters by tenant', async () => {
    const updated = { id: 'vc1', channel_name: 'New Name', status: 'disconnected' }
    mockQuery.mockResolvedValueOnce({ rows: [updated] })

    const { updateVideoChannel } = await import('../../../src/db/video-queries')
    const result = await updateVideoChannel(TENANT, 'vc1', {
      channelName: 'New Name',
      status: 'disconnected',
    })

    expect(result).toEqual(updated)
    expect(sqlAt()).toContain('UPDATE video_channels SET')
    expect(sqlAt()).toContain('channel_name = $3')
    expect(sqlAt()).toContain('status = $4')
    expect(sqlAt()).toContain('updated_at = now()')
    expect(sqlAt()).toContain('WHERE id = $2 AND tenant_id = $1')
    expect(sqlAt()).toContain('RETURNING *')
    expect(paramsAt()[0]).toBe(TENANT)
    expect(paramsAt()[1]).toBe('vc1')
  })

  it('returns existing row when no updates provided', async () => {
    const existing = { id: 'vc1', channel_name: 'Same' }
    mockQuery.mockResolvedValueOnce({ rows: [existing] })

    const { updateVideoChannel } = await import('../../../src/db/video-queries')
    const result = await updateVideoChannel(TENANT, 'vc1', {})

    expect(result).toEqual(existing)
    // Should have called getVideoChannelById (SELECT, not UPDATE)
    expect(sqlAt()).toContain('SELECT *')
  })
})

describe('video_channels – deleteVideoChannel', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('returns true when a row is deleted', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'vc1' }] })

    const { deleteVideoChannel } = await import('../../../src/db/video-queries')
    const result = await deleteVideoChannel(TENANT, 'vc1')

    expect(result).toBe(true)
    expect(sqlAt()).toContain('DELETE FROM video_channels')
    expect(sqlAt()).toContain('tenant_id = $2')
    expect(paramsAt()).toEqual(['vc1', TENANT])
  })

  it('returns false when no row matches', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })

    const { deleteVideoChannel } = await import('../../../src/db/video-queries')
    const result = await deleteVideoChannel(TENANT, 'missing')

    expect(result).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  oauth_tokens
// ═══════════════════════════════════════════════════════════════════════════

describe('oauth_tokens – insertOAuthToken', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('inserts with required fields', async () => {
    const created = {
      id: 'ot1', tenant_id: TENANT, platform: 'youtube',
      access_token_encrypted: 'enc-access',
      refresh_token_encrypted: null, expires_at: null, scope: null,
      created_at: '2026-01-01', updated_at: '2026-01-01',
    }
    mockQuery.mockResolvedValueOnce({ rows: [created] })

    const { insertOAuthToken } = await import('../../../src/db/video-queries')
    const result = await insertOAuthToken(TENANT, {
      platform: 'youtube',
      refreshTokenEnc: 'enc-access',
      scopes: '',
    })

    expect(result).toEqual(created)
    expect(sqlAt()).toContain('INSERT INTO oauth_tokens')
    expect(sqlAt()).toContain('RETURNING *')
    expect(paramsAt()[0]).toBe(TENANT)
    expect(paramsAt()[1]).toBe('youtube')
  })

  it('passes optional fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'ot2' }] })

    const { insertOAuthToken } = await import('../../../src/db/video-queries')
    await insertOAuthToken(TENANT, {
      platform: 'tiktok',
      accessTokenEnc: 'enc-a',
      refreshTokenEnc: 'enc-r',
      tokenExpiresAt: '2026-12-31T00:00:00Z',
      scopes: 'read analytics',
    })

    const p = paramsAt()
    expect(p[2]).toBe('enc-a')
    expect(p[3]).toBe('enc-r')
    expect(p[4]).toBe('2026-12-31T00:00:00Z')
    expect(p[5]).toBe('read analytics')
  })
})

describe('oauth_tokens – getOAuthTokenById', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('filters by both id and tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'ot1' }] })

    const { getOAuthTokenById } = await import('../../../src/db/video-queries')
    const result = await getOAuthTokenById(TENANT, 'ot1')

    expect(result).toEqual({ id: 'ot1' })
    expect(sqlAt()).toContain('id = $1')
    expect(sqlAt()).toContain('tenant_id = $2')
    expect(paramsAt()).toEqual(['ot1', TENANT])
  })

  it('returns null when not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { getOAuthTokenById } = await import('../../../src/db/video-queries')
    expect(await getOAuthTokenById(TENANT, 'nope')).toBeNull()
  })
})

describe('oauth_tokens – getLatestOAuthToken', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('returns the most recent token for a platform', async () => {
    const row = { id: 'ot3', platform: 'youtube', created_at: '2026-06-01' }
    mockQuery.mockResolvedValueOnce({ rows: [row] })

    const { getLatestOAuthToken } = await import('../../../src/db/video-queries')
    const result = await getLatestOAuthToken(TENANT, 'youtube')

    expect(result).toEqual(row)
    expect(sqlAt()).toContain('tenant_id = $1')
    expect(sqlAt()).toContain('platform = $2')
    expect(sqlAt()).toContain('ORDER BY created_at DESC')
    expect(sqlAt()).toContain('LIMIT 1')
    expect(paramsAt()).toEqual([TENANT, 'youtube'])
  })
})

describe('oauth_tokens – updateOAuthToken', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('builds SET clause dynamically with tenant guard', async () => {
    const updated = { id: 'ot1', access_token_enc: 'new-enc' }
    mockQuery.mockResolvedValueOnce({ rows: [updated] })

    const { updateOAuthToken } = await import('../../../src/db/video-queries')
    const result = await updateOAuthToken(TENANT, 'ot1', {
      accessTokenEnc: 'new-enc',
    })

    expect(result).toEqual(updated)
    expect(sqlAt()).toContain('UPDATE oauth_tokens SET')
    expect(sqlAt()).toContain('access_token_enc = $3')
    expect(sqlAt()).toContain('updated_at = now()')
    expect(sqlAt()).toContain('WHERE id = $2 AND tenant_id = $1')
    expect(sqlAt()).toContain('RETURNING *')
  })
})

describe('oauth_tokens – deleteOAuthToken', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('returns true on successful delete', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'ot1' }] })

    const { deleteOAuthToken } = await import('../../../src/db/video-queries')
    expect(await deleteOAuthToken(TENANT, 'ot1')).toBe(true)
    expect(sqlAt()).toContain('DELETE FROM oauth_tokens')
    expect(sqlAt()).toContain('tenant_id = $2')
  })

  it('returns false when no row matches', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })

    const { deleteOAuthToken } = await import('../../../src/db/video-queries')
    expect(await deleteOAuthToken(TENANT, 'missing')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  video_earnings
// ═══════════════════════════════════════════════════════════════════════════

describe('video_earnings – insertVideoEarning', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('inserts with required fields and returns created row', async () => {
    const created = {
      id: 've1', tenant_id: TENANT, channel_id: 'vc1',
      date: '2026-01-15', estimated_earnings: null, currency: null,
      ad_revenue: null, cpm: null, rpm: null, views_count: null,
      metadata: null, created_at: '2026-01-15', updated_at: '2026-01-15',
    }
    mockQuery.mockResolvedValueOnce({ rows: [created] })

    const { insertVideoEarning } = await import('../../../src/db/video-queries')
    const result = await insertVideoEarning(TENANT, 'vc1', '2026-01-15')

    expect(result).toEqual(created)
    expect(sqlAt()).toContain('INSERT INTO video_earnings')
    expect(sqlAt()).toContain('RETURNING *')
    expect(paramsAt()[0]).toBe(TENANT)
    expect(paramsAt()[1]).toBe('vc1')
    expect(paramsAt()[2]).toBe('2026-01-15')
  })

  it('passes optional numeric and metadata fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 've2' }] })

    const { insertVideoEarning } = await import('../../../src/db/video-queries')
    await insertVideoEarning(
      TENANT, 'vc1', '2026-01-15',
      12.50, 'USD', 10.00, 2.50, 5.00, 4000,
      { source: 'api' },
    )

    const p = paramsAt()
    expect(p[3]).toBe(12.50)
    expect(p[4]).toBe('USD')
    expect(p[5]).toBe(10.00)
    expect(p[6]).toBe(2.50)
    expect(p[7]).toBe(5.00)
    expect(p[8]).toBe(4000)
    expect(p[9]).toBe('{"source":"api"}')
  })
})

describe('video_earnings – getVideoEarningsByChannel', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('queries without date range', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 've1' }] })

    const { getVideoEarningsByChannel } = await import('../../../src/db/video-queries')
    const result = await getVideoEarningsByChannel(TENANT, 'vc1')

    expect(result).toHaveLength(1)
    expect(sqlAt()).toContain('tenant_id = $1')
    expect(sqlAt()).toContain('channel_id = $2')
    expect(sqlAt()).not.toContain('date >=')
    expect(paramsAt()).toEqual([TENANT, 'vc1'])
  })

  it('applies date range filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { getVideoEarningsByChannel } = await import('../../../src/db/video-queries')
    await getVideoEarningsByChannel(TENANT, 'vc1', {
      start: '2026-01-01',
      end: '2026-01-31',
    })

    const sql = sqlAt()
    expect(sql).toContain('date >= $3::date')
    expect(sql).toContain('date <= $4::date')
    expect(paramsAt()).toEqual([TENANT, 'vc1', '2026-01-01', '2026-01-31'])
  })
})

describe('video_earnings – getVideoEarningsByDate', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('returns all earnings for a given date within the tenant', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 've1', channel_id: 'vc1' }, { id: 've2', channel_id: 'vc2' }],
    })

    const { getVideoEarningsByDate } = await import('../../../src/db/video-queries')
    const result = await getVideoEarningsByDate(TENANT, '2026-01-15')

    expect(result).toHaveLength(2)
    expect(sqlAt()).toContain('tenant_id = $1')
    expect(sqlAt()).toContain('date = $2::date')
    expect(paramsAt()).toEqual([TENANT, '2026-01-15'])
  })
})

describe('video_earnings – upsertVideoEarning (tenant isolation)', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('uses ON CONFLICT on (tenant_id, channel_id, date)', async () => {
    const upserted = {
      id: 've1', tenant_id: TENANT, channel_id: 'vc1',
      date: '2026-01-15', estimated_earnings: 20.00,
    }
    mockQuery.mockResolvedValueOnce({ rows: [upserted] })

    const { upsertVideoEarning } = await import('../../../src/db/video-queries')
    const result = await upsertVideoEarning(TENANT, 'vc1', '2026-01-15', {
      estimatedEarnings: 20.00,
    })

    expect(result).toEqual(upserted)
    expect(sqlAt()).toContain('ON CONFLICT (tenant_id, channel_id, date) DO UPDATE SET')
    expect(sqlAt()).toContain('estimated_earnings = EXCLUDED.estimated_earnings')
    expect(sqlAt()).toContain('updated_at')
    expect(sqlAt()).toContain('now()')
    expect(sqlAt()).toContain('RETURNING *')
  })

  it('passes all updatable fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 've1' }] })

    const { upsertVideoEarning } = await import('../../../src/db/video-queries')
    await upsertVideoEarning(TENANT, 'vc1', '2026-01-15', {
      estimatedEarnings: 15.00,
      currency: 'EUR',
      adRevenue: 12.00,
      cpm: 3.00,
      rpm: 4.50,
      viewsCount: 5000,
      metadata: { note: 'reconciled' },
    })

    const p = paramsAt()
    expect(p[0]).toBe(TENANT)
    expect(p[1]).toBe('vc1')
    expect(p[2]).toBe('2026-01-15')
    expect(p[3]).toBe(15.00)
    expect(p[4]).toBe('EUR')
    expect(p[5]).toBe(12.00)
    expect(p[6]).toBe(3.00)
    expect(p[7]).toBe(4.50)
    expect(p[8]).toBe(5000)
    expect(p[9]).toBe('{"note":"reconciled"}')
  })

  it('enforces tenant_id in the conflict target', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 've1' }] })

    const { upsertVideoEarning } = await import('../../../src/db/video-queries')
    await upsertVideoEarning(OTHER_TENANT, 'vc1', '2026-01-15', {
      estimatedEarnings: 5.00,
    })

    // The conflict target must include tenant_id so that the same channel+date
    // in a different tenant does not collide.
    expect(sqlAt()).toContain('ON CONFLICT (tenant_id, channel_id, date)')
    expect(paramsAt()[0]).toBe(OTHER_TENANT)
  })
})

describe('video_earnings – deleteVideoEarning', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('returns true on successful delete', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 've1' }] })

    const { deleteVideoEarning } = await import('../../../src/db/video-queries')
    expect(await deleteVideoEarning(TENANT, 've1')).toBe(true)
    expect(sqlAt()).toContain('DELETE FROM video_earnings')
    expect(sqlAt()).toContain('tenant_id = $2')
    expect(paramsAt()).toEqual(['ve1', TENANT])
  })

  it('returns false when no row matches', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })

    const { deleteVideoEarning } = await import('../../../src/db/video-queries')
    expect(await deleteVideoEarning(TENANT, 'missing')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  video_audience_metrics
// ═══════════════════════════════════════════════════════════════════════════

describe('video_audience_metrics – insertVideoAudienceMetric', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('inserts with required fields', async () => {
    const created = {
      id: 'vam1', tenant_id: TENANT, channel_id: 'vc1',
      week_start: '2026-01-12', subscribers_count: null,
      total_views: null, watch_time_minutes: null,
      engagement_rate: null, metadata: null,
      created_at: '2026-01-12', updated_at: '2026-01-12',
    }
    mockQuery.mockResolvedValueOnce({ rows: [created] })

    const { insertVideoAudienceMetric } = await import('../../../src/db/video-queries')
    const result = await insertVideoAudienceMetric(TENANT, 'vc1', '2026-01-12')

    expect(result).toEqual(created)
    expect(sqlAt()).toContain('INSERT INTO video_audience_metrics')
    expect(sqlAt()).toContain('RETURNING *')
    expect(paramsAt()[0]).toBe(TENANT)
    expect(paramsAt()[1]).toBe('vc1')
    expect(paramsAt()[2]).toBe('2026-01-12')
  })

  it('passes optional numeric and metadata fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'vam2' }] })

    const { insertVideoAudienceMetric } = await import('../../../src/db/video-queries')
    await insertVideoAudienceMetric(
      TENANT, 'vc1', '2026-01-12',
      1500, 25000, 180000, 0.045,
      { source: 'api' },
    )

    const p = paramsAt()
    expect(p[3]).toBe(1500)
    expect(p[4]).toBe(25000)
    expect(p[5]).toBe(180000)
    expect(p[6]).toBe(0.045)
    expect(p[7]).toBe('{"source":"api"}')
  })
})

describe('video_audience_metrics – getVideoAudienceMetricsByChannel', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('queries without date range', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'vam1' }] })

    const { getVideoAudienceMetricsByChannel } = await import('../../../src/db/video-queries')
    const result = await getVideoAudienceMetricsByChannel(TENANT, 'vc1')

    expect(result).toHaveLength(1)
    expect(sqlAt()).toContain('tenant_id = $1')
    expect(sqlAt()).toContain('channel_id = $2')
    expect(sqlAt()).not.toContain('week_start >=')
    expect(paramsAt()).toEqual([TENANT, 'vc1'])
  })

  it('applies date range filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { getVideoAudienceMetricsByChannel } = await import('../../../src/db/video-queries')
    await getVideoAudienceMetricsByChannel(TENANT, 'vc1', {
      start: '2026-01-01',
      end: '2026-01-31',
    })

    const sql = sqlAt()
    expect(sql).toContain('week_start >= $3::date')
    expect(sql).toContain('week_start <= $4::date')
    expect(paramsAt()).toEqual([TENANT, 'vc1', '2026-01-01', '2026-01-31'])
  })
})

describe('video_audience_metrics – upsertVideoAudienceMetric (tenant isolation)', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('uses ON CONFLICT on (tenant_id, channel_id, week_start)', async () => {
    const upserted = {
      id: 'vam1', tenant_id: TENANT, channel_id: 'vc1',
      week_start: '2026-01-12', subscribers_count: 2000,
    }
    mockQuery.mockResolvedValueOnce({ rows: [upserted] })

    const { upsertVideoAudienceMetric } = await import('../../../src/db/video-queries')
    const result = await upsertVideoAudienceMetric(TENANT, 'vc1', '2026-01-12', {
      subscribersCount: 2000,
    })

    expect(result).toEqual(upserted)
    expect(sqlAt()).toContain('ON CONFLICT (tenant_id, channel_id, week_start) DO UPDATE SET')
    expect(sqlAt()).toContain('subscribers_count')
    expect(sqlAt()).toContain('EXCLUDED.subscribers_count')
    expect(sqlAt()).toContain('updated_at')
    expect(sqlAt()).toContain('now()')
    expect(sqlAt()).toContain('RETURNING *')
  })

  it('enforces tenant_id in the conflict target', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'vam1' }] })

    const { upsertVideoAudienceMetric } = await import('../../../src/db/video-queries')
    await upsertVideoAudienceMetric(OTHER_TENANT, 'vc1', '2026-01-12', {
      subscribersCount: 500,
    })

    expect(sqlAt()).toContain('ON CONFLICT (tenant_id, channel_id, week_start)')
    expect(paramsAt()[0]).toBe(OTHER_TENANT)
  })

  it('passes all updatable fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'vam1' }] })

    const { upsertVideoAudienceMetric } = await import('../../../src/db/video-queries')
    await upsertVideoAudienceMetric(TENANT, 'vc1', '2026-01-12', {
      subscribersCount: 1500,
      totalViews: 30000,
      watchTimeMinutes: 200000,
      engagementRate: 0.05,
      metadata: { week: 2 },
    })

    const p = paramsAt()
    expect(p[3]).toBe(1500)
    expect(p[4]).toBe(30000)
    expect(p[5]).toBe(200000)
    expect(p[6]).toBe(0.05)
    expect(p[7]).toBe('{"week":2}')
  })
})

describe('video_audience_metrics – deleteVideoAudienceMetric', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('returns true on successful delete', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'vam1' }] })

    const { deleteVideoAudienceMetric } = await import('../../../src/db/video-queries')
    expect(await deleteVideoAudienceMetric(TENANT, 'vam1')).toBe(true)
    expect(sqlAt()).toContain('DELETE FROM video_audience_metrics')
    expect(sqlAt()).toContain('tenant_id = $2')
    expect(paramsAt()).toEqual(['vam1', TENANT])
  })

  it('returns false when no row matches', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })

    const { deleteVideoAudienceMetric } = await import('../../../src/db/video-queries')
    expect(await deleteVideoAudienceMetric(TENANT, 'missing')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  API-compatibility wrappers (context-accepting overloads)
// ═══════════════════════════════════════════════════════════════════════════

const CTX = { tenantId: TENANT, userId: 'u1', userRole: 'admin' as const }

describe('queryVideoChannel (context-accepting alias)', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('delegates to getVideoChannelById with context.tenantId', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'vc1' }] })

    const { queryVideoChannel } = await import('../../../src/db/video-queries')
    const result = await queryVideoChannel(CTX, 'vc1')

    expect(result).toEqual({ id: 'vc1' })
    expect(sqlAt()).toContain('tenant_id = $2')
    expect(paramsAt()).toEqual(['vc1', TENANT])
  })
})

describe('queryVideoChannelsPage', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('issues a count query then a paged select, both tenant-scoped', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: 42 }] })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'vc1' }] })

    const { queryVideoChannelsPage } = await import('../../../src/db/video-queries')
    const result = await queryVideoChannelsPage(CTX, { platform: 'youtube' }, { limit: 10, offset: 0 })

    expect(result).toEqual({ items: [{ id: 'vc1' }], total: 42 })

    const countSql = sqlAt(0)
    expect(countSql).toContain('count(*)::int')
    expect(countSql).toContain('tenant_id = $1')
    expect(countSql).toContain('platform = $2')

    const pageSql = sqlAt(1)
    expect(pageSql).toContain('ORDER BY created_at DESC')
    expect(pageSql).toContain('LIMIT $3 OFFSET $4')
    expect(paramsAt(1)).toEqual([TENANT, 'youtube', 10, 0])
  })
})

describe('insertVideoChannel (context overload)', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('accepts (context, data) and delegates to the base insert', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'vc1' }] })

    const { insertVideoChannel } = await import('../../../src/db/video-queries')
    const result = await insertVideoChannel(CTX, {
      platform: 'youtube',
      platformChannelId: 'UC123',
      channelName: 'Test',
      ownership: 'self',
    })

    expect(result).toEqual({ id: 'vc1' })
    expect(paramsAt()[0]).toBe(TENANT)
    expect(paramsAt()[1]).toBe('youtube')
    expect(paramsAt()[2]).toBe('UC123')
    expect(paramsAt()[3]).toBe('Test')
  })
})

describe('clearChannelOAuthToken', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('sets oauth_token_id to NULL for the channel', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { clearChannelOAuthToken } = await import('../../../src/db/video-queries')
    await clearChannelOAuthToken(CTX, 'vc1')

    expect(sqlAt()).toContain('oauth_token_id = NULL')
    expect(sqlAt()).toContain('tenant_id = $2')
    expect(paramsAt()).toEqual(['vc1', TENANT])
  })
})

describe('queryOAuthTokenById (alias)', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('is the same function as getOAuthTokenById', async () => {
    const mod = await import('../../../src/db/video-queries')
    expect(mod.queryOAuthTokenById).toBe(mod.getOAuthTokenById)
  })
})

describe('insertOAuthToken (context overload)', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('accepts (tenantId, data) and delegates to base insert', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'ot1' }] })

    const { insertOAuthToken } = await import('../../../src/db/video-queries')
    const result = await insertOAuthToken(TENANT, {
      platform: 'youtube',
      refreshTokenEnc: 'enc-refresh',
      accessTokenEnc: 'enc-access',
      tokenExpiresAt: '2026-12-31',
      scopes: 'youtube.readonly',
    })

    expect(result).toEqual({ id: 'ot1' })
    expect(sqlAt()).toContain('INSERT INTO oauth_tokens')
    expect(paramsAt()[0]).toBe(TENANT)
    expect(paramsAt()[1]).toBe('youtube')
    expect(paramsAt()[2]).toBe('enc-access')
    expect(paramsAt()[3]).toBe('enc-refresh')
    expect(paramsAt()[4]).toBe('2026-12-31')
    expect(paramsAt()[5]).toBe('youtube.readonly')
  })
})

describe('deleteVideoChannel (context overload)', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('accepts a context object and extracts tenantId', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'vc1' }] })

    const { deleteVideoChannel } = await import('../../../src/db/video-queries')
    const result = await deleteVideoChannel(CTX, 'vc1')

    expect(result).toBe(true)
    expect(paramsAt()).toEqual(['vc1', TENANT])
  })
})

describe('deleteOAuthToken (context overload)', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('accepts a context object and extracts tenantId', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'ot1' }] })

    const { deleteOAuthToken } = await import('../../../src/db/video-queries')
    const result = await deleteOAuthToken(CTX, 'ot1')

    expect(result).toBe(true)
    expect(paramsAt()).toEqual(['ot1', TENANT])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Cross-cutting: tenant isolation
// ═══════════════════════════════════════════════════════════════════════════

describe('tenant isolation – every query includes tenant_id predicate', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('getVideoChannelById filters by tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { getVideoChannelById } = await import('../../../src/db/video-queries')
    await getVideoChannelById(TENANT, 'vc1')
    expect(sqlAt()).toContain('tenant_id = $2')
  })

  it('getVideoChannelByPlatformId filters by tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { getVideoChannelByPlatformId } = await import('../../../src/db/video-queries')
    await getVideoChannelByPlatformId(TENANT, 'youtube', 'UC123')
    expect(sqlAt()).toContain('tenant_id = $1')
  })

  it('listVideoChannels filters by tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { listVideoChannels } = await import('../../../src/db/video-queries')
    await listVideoChannels(TENANT)
    expect(sqlAt()).toContain('tenant_id = $1')
  })

  it('updateVideoChannel guards on tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { updateVideoChannel } = await import('../../../src/db/video-queries')
    await updateVideoChannel(TENANT, 'vc1', { channelName: 'X' })
    expect(sqlAt()).toContain('tenant_id = $1')
  })

  it('deleteVideoChannel guards on tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    const { deleteVideoChannel } = await import('../../../src/db/video-queries')
    await deleteVideoChannel(TENANT, 'vc1')
    expect(sqlAt()).toContain('tenant_id = $2')
  })

  it('getOAuthTokenById filters by tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { getOAuthTokenById } = await import('../../../src/db/video-queries')
    await getOAuthTokenById(TENANT, 'ot1')
    expect(sqlAt()).toContain('tenant_id = $2')
  })

  it('getLatestOAuthToken filters by tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { getLatestOAuthToken } = await import('../../../src/db/video-queries')
    await getLatestOAuthToken(TENANT, 'youtube')
    expect(sqlAt()).toContain('tenant_id = $1')
  })

  it('updateOAuthToken guards on tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { updateOAuthToken } = await import('../../../src/db/video-queries')
    await updateOAuthToken(TENANT, 'ot1', { accessTokenEnc: 'x' })
    expect(sqlAt()).toContain('tenant_id = $1')
  })

  it('deleteOAuthToken guards on tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    const { deleteOAuthToken } = await import('../../../src/db/video-queries')
    await deleteOAuthToken(TENANT, 'ot1')
    expect(sqlAt()).toContain('tenant_id = $2')
  })

  it('getVideoEarningsByChannel filters by tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { getVideoEarningsByChannel } = await import('../../../src/db/video-queries')
    await getVideoEarningsByChannel(TENANT, 'vc1')
    expect(sqlAt()).toContain('tenant_id = $1')
  })

  it('getVideoEarningsByDate filters by tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { getVideoEarningsByDate } = await import('../../../src/db/video-queries')
    await getVideoEarningsByDate(TENANT, '2026-01-15')
    expect(sqlAt()).toContain('tenant_id = $1')
  })

  it('deleteVideoEarning guards on tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    const { deleteVideoEarning } = await import('../../../src/db/video-queries')
    await deleteVideoEarning(TENANT, 've1')
    expect(sqlAt()).toContain('tenant_id = $2')
  })

  it('getVideoAudienceMetricsByChannel filters by tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { getVideoAudienceMetricsByChannel } = await import('../../../src/db/video-queries')
    await getVideoAudienceMetricsByChannel(TENANT, 'vc1')
    expect(sqlAt()).toContain('tenant_id = $1')
  })

  it('deleteVideoAudienceMetric guards on tenant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] })
    const { deleteVideoAudienceMetric } = await import('../../../src/db/video-queries')
    await deleteVideoAudienceMetric(TENANT, 'vam1')
    expect(sqlAt()).toContain('tenant_id = $2')
  })
})
