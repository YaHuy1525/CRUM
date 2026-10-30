// tests/unit/api/video-revenue.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

/**
 * The Phase 6 revenue read-only routes, exercised over real HTTP with the DB
 * aggregation layer and the channel CRUD getter stubbed (so no pg loads). The
 * router is a thin composition of the shared aggregation calls, so the seams that
 * matter are: it wires countOpenRevenueAlerts into openAlerts, echoes the parsed
 * range, hands the tenantId + range to each db function, passes decimal-as-TEXT
 * money through UNCHANGED, and rejects bad input (missing identity, non-uuid id,
 * malformed/impossible dates) BEFORE any database is touched.
 */
const revenueDb = vi.hoisted(() => ({
  sumEarningsByChannel: vi.fn(),
  earningsSeries: vi.fn(),
  sumRevenueTotals: vi.fn(),
  countOpenRevenueAlerts: vi.fn(),
}))

const videoDb = vi.hoisted(() => ({
  getVideoChannelById: vi.fn(),
}))

vi.mock('../../../src/db/revenue-queries', () => revenueDb)
vi.mock('../../../src/db/video-queries', () => videoDb)

import { createVideoRevenueRouter } from '../../../src/api/video-revenue'
import { parseEnv } from '../../../src/config/env'

const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const USER = '660e8400-e29b-41d4-a716-446655440009'
const CHANNEL = '880e8400-e29b-41d4-a716-446655440011'

const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}

function router(): Hono {
  return createVideoRevenueRouter({ env: parseEnv({}) })
}

function totalsRow(over: Record<string, unknown> = {}) {
  return {
    currency: 'USD',
    platform_revenue: '1234.56',
    sponsorship_revenue: '700.00',
    grand_total: '1934.56',
    channels_with_earnings: 2,
    ...over,
  }
}

function channelRevenueRow(over: Record<string, unknown> = {}) {
  return {
    channel_id: CHANNEL,
    channel_name: 'My Channel',
    platform: 'youtube',
    ownership: 'self',
    status: 'active',
    currency: 'USD',
    total_revenue: '1234.56',
    total_views: 42000,
    last_sync_at: '2026-01-31 12:00:00+00',
    ...over,
  }
}

function channelRow(over: Record<string, unknown> = {}) {
  return { id: CHANNEL, tenant_id: TENANT, platform: 'youtube', ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('identity gate', () => {
  it('refuses /overview before touching the database', async () => {
    const res = await router().request('/api/video/revenue/overview', {
      headers: { 'x-tenant-id': TENANT },
    })
    expect(res.status).toBe(401)
    expect((await json<{ error: string }>(res)).error).toBe('unauthorized')
    expect(revenueDb.sumRevenueTotals).not.toHaveBeenCalled()
    expect(revenueDb.sumEarningsByChannel).not.toHaveBeenCalled()
    expect(revenueDb.countOpenRevenueAlerts).not.toHaveBeenCalled()
  })

  it('refuses /channels/:id/series before touching the database', async () => {
    const res = await router().request(`/api/video/revenue/channels/${CHANNEL}/series`, {
      headers: { 'x-user-id': USER },
    })
    expect(res.status).toBe(401)
    expect((await json<{ error: string }>(res)).error).toBe('unauthorized')
    expect(videoDb.getVideoChannelById).not.toHaveBeenCalled()
    expect(revenueDb.earningsSeries).not.toHaveBeenCalled()
  })
})

describe('GET /api/video/revenue/overview', () => {
  it('composes totals, channels and alerts and echoes the parsed range', async () => {
    revenueDb.sumRevenueTotals.mockResolvedValue(totalsRow())
    revenueDb.sumEarningsByChannel.mockResolvedValue([channelRevenueRow()])
    revenueDb.countOpenRevenueAlerts.mockResolvedValue(3)

    const body = await json<{
      range: { from: string | null; to: string | null }
      totals: Record<string, unknown>
      channels: { channel_id: string; total_revenue: string }[]
      openAlerts: number
    }>(router().request('/api/video/revenue/overview?from=2026-01-01&to=2026-01-31', { headers: AUTH }))

    expect(body.range).toEqual({ from: '2026-01-01', to: '2026-01-31' })
    expect(body.totals).toMatchObject({ grand_total: '1934.56', channels_with_earnings: 2 })
    expect(body.channels[0]!.channel_id).toBe(CHANNEL)
    // decimal-as-TEXT money must pass through unchanged, never coerced to a number.
    expect(body.channels[0]!.total_revenue).toBe('1234.56')
    expect(typeof body.channels[0]!.total_revenue).toBe('string')
    expect(body.openAlerts).toBe(3)

    expect(revenueDb.sumRevenueTotals).toHaveBeenCalledWith(TENANT, {
      from: '2026-01-01',
      to: '2026-01-31',
    })
    expect(revenueDb.sumEarningsByChannel).toHaveBeenCalledWith(TENANT, {
      from: '2026-01-01',
      to: '2026-01-31',
    })
    expect(revenueDb.countOpenRevenueAlerts).toHaveBeenCalledWith(TENANT)
  })

  it('null-echoes an absent range and hands the db layer undefined bounds', async () => {
    revenueDb.sumRevenueTotals.mockResolvedValue(totalsRow({ currency: null }))
    revenueDb.sumEarningsByChannel.mockResolvedValue([])
    revenueDb.countOpenRevenueAlerts.mockResolvedValue(0)

    const body = await json<{
      range: { from: string | null; to: string | null }
      openAlerts: number
    }>(router().request('/api/video/revenue/overview', { headers: AUTH }))

    expect(body.range).toEqual({ from: null, to: null })
    expect(body.openAlerts).toBe(0)
    expect(revenueDb.sumRevenueTotals).toHaveBeenCalledWith(TENANT, {
      from: undefined,
      to: undefined,
    })
    expect(revenueDb.sumEarningsByChannel).toHaveBeenCalledWith(TENANT, {
      from: undefined,
      to: undefined,
    })
  })

  it('rejects a non-date "from" before the database', async () => {
    const res = await router().request('/api/video/revenue/overview?from=today', { headers: AUTH })
    expect(res.status).toBe(400)
    expect((await json<{ error: string; detail: string }>(res))).toMatchObject({
      error: 'invalid_query',
      detail: 'from and to must be YYYY-MM-DD',
    })
    expect(revenueDb.sumRevenueTotals).not.toHaveBeenCalled()
  })

  it('rejects an impossible calendar date "2026-13-40" before the database', async () => {
    const res = await router().request('/api/video/revenue/overview?from=2026-13-40', { headers: AUTH })
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toBe('invalid_query')
    expect(revenueDb.sumRevenueTotals).not.toHaveBeenCalled()
  })

  it('rejects a malformed "to" before the database', async () => {
    const res = await router().request('/api/video/revenue/overview?to=2026-1-1', { headers: AUTH })
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toBe('invalid_query')
    expect(revenueDb.sumEarningsByChannel).not.toHaveBeenCalled()
  })

  it('answers 500 internal_error when an aggregation call throws', async () => {
    revenueDb.sumRevenueTotals.mockRejectedValue(new Error('db exploded'))
    revenueDb.sumEarningsByChannel.mockResolvedValue([])
    revenueDb.countOpenRevenueAlerts.mockResolvedValue(0)

    const res = await router().request('/api/video/revenue/overview', { headers: AUTH })
    expect(res.status).toBe(500)
    expect((await json<{ error: string; detail: string }>(res))).toMatchObject({
      error: 'internal_error',
      detail: 'db exploded',
    })
  })
})

describe('GET /api/video/revenue/channels/:id/series', () => {
  it('returns points and the channel id when the channel exists', async () => {
    videoDb.getVideoChannelById.mockResolvedValue(channelRow())
    revenueDb.earningsSeries.mockResolvedValue([
      { date: '2026-01-01', revenue: '10.50', views: 100 },
      { date: '2026-01-02', revenue: '20.00', views: null },
    ])

    const body = await json<{ channel_id: string; points: { revenue: string }[] }>(
      router().request(`/api/video/revenue/channels/${CHANNEL}/series?from=2026-01-01`, { headers: AUTH }),
    )

    expect(body.channel_id).toBe(CHANNEL)
    expect(body.points).toHaveLength(2)
    expect(body.points[0]!.revenue).toBe('10.50')

    expect(videoDb.getVideoChannelById).toHaveBeenCalledWith(TENANT, CHANNEL)
    expect(revenueDb.earningsSeries).toHaveBeenCalledWith(TENANT, CHANNEL, {
      from: '2026-01-01',
      to: undefined,
    })
  })

  it('answers 404 when the channel does not exist', async () => {
    videoDb.getVideoChannelById.mockResolvedValue(null)
    const res = await router().request(`/api/video/revenue/channels/${CHANNEL}/series`, { headers: AUTH })
    expect(res.status).toBe(404)
    expect((await json<{ error: string }>(res)).error).toBe('not_found')
    expect(revenueDb.earningsSeries).not.toHaveBeenCalled()
  })

  it('rejects a non-uuid id before the database', async () => {
    const res = await router().request('/api/video/revenue/channels/not-a-uuid/series', { headers: AUTH })
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toBe('invalid_id')
    expect(videoDb.getVideoChannelById).not.toHaveBeenCalled()
    expect(revenueDb.earningsSeries).not.toHaveBeenCalled()
  })

  it('rejects a malformed "from" before the database', async () => {
    const res = await router().request(`/api/video/revenue/channels/${CHANNEL}/series?from=today`, {
      headers: AUTH,
    })
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toBe('invalid_query')
    expect(videoDb.getVideoChannelById).not.toHaveBeenCalled()
  })

  it('answers 500 internal_error when the series call throws', async () => {
    videoDb.getVideoChannelById.mockResolvedValue(channelRow())
    revenueDb.earningsSeries.mockRejectedValue(new Error('series exploded'))

    const res = await router().request(`/api/video/revenue/channels/${CHANNEL}/series`, { headers: AUTH })
    expect(res.status).toBe(500)
    expect((await json<{ error: string; detail: string }>(res))).toMatchObject({
      error: 'internal_error',
      detail: 'series exploded',
    })
  })
})
