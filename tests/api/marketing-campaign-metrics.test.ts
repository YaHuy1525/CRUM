import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

const db = vi.hoisted(() => ({
  listAllCampaigns: vi.fn(),
}))

const metricsDb = vi.hoisted(() => ({
  listRecentSnapshots: vi.fn(),
}))

vi.mock('../../src/db/marketing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/marketing')>()
  return {
    ...actual,
    listAllCampaigns: db.listAllCampaigns,
  }
})

vi.mock('../../src/db/marketing-metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/marketing-metrics')>()
  return {
    ...actual,
    listRecentSnapshots: metricsDb.listRecentSnapshots,
  }
})

// The router imports the stagers from this module, and while marketing-writes is
// being evaluated it reads constants from src/db/marketing. The partial mock
// above re-exports everything from the real module except listAllCampaigns, so
// the stager module loads correctly.
vi.mock('../../src/mastra/tools/marketing-writes', () => ({
  stagePromotion: vi.fn(),
  stageRetry: vi.fn(),
}))

import { createMarketingRouter } from '../../src/api/marketing'
import { parseEnv } from '../../src/config/env'

const TENANT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const CAMPAIGN_EXT = 'camp_abc123'
const AD_ACCOUNT = 'act_12345'

const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'user' }

function router(): Hono {
  return createMarketingRouter({ env: parseEnv({}) })
}

function fetchMetrics(tenantId = TENANT, headers: Record<string, string> = AUTH) {
  return router().request(`/api/marketing/campaign-metrics?tenantId=${tenantId}`, { headers })
}

beforeEach(() => {
  vi.clearAllMocks()
  db.listAllCampaigns.mockResolvedValue([])
  metricsDb.listRecentSnapshots.mockResolvedValue([])
})

describe('GET /api/marketing/campaign-metrics', () => {
  it('401s when the identity is rejected', async () => {
    const res = await fetchMetrics(TENANT, { 'x-user-role': 'auditor' })
    expect(res.status).toBe(401)
    expect(db.listAllCampaigns).not.toHaveBeenCalled()
  })

  it('400s when tenantId is missing', async () => {
    const res = await router().request('/api/marketing/campaign-metrics', { headers: AUTH })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'tenantId_required' })
  })

  it('returns an empty items array when there are no campaigns', async () => {
    db.listAllCampaigns.mockResolvedValue([])
    metricsDb.listRecentSnapshots.mockResolvedValue([])
    const res = await fetchMetrics()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ items: [] })
    expect(db.listAllCampaigns).toHaveBeenCalledWith(TENANT)
    expect(metricsDb.listRecentSnapshots).toHaveBeenCalledWith(TENANT, 7)
  })

  it('aggregates metrics snapshots per campaign and computes cost per lead', async () => {
    db.listAllCampaigns.mockResolvedValue([{
      bundleId: BUNDLE,
      campaignExternalId: CAMPAIGN_EXT,
      adAccountId: AD_ACCOUNT,
      campaignName: 'Winter outreach',
      status: 'ACTIVE',
      analysis: null,
    }])
    metricsDb.listRecentSnapshots.mockResolvedValue([
      {
        id: 's1',
        tenantId: TENANT,
        bundleId: BUNDLE,
        campaignExternalId: CAMPAIGN_EXT,
        windowStart: '2026-10-24T00:00:00Z',
        windowEnd: '2026-10-25T00:00:00Z',
        metrics: { data: [{ impressions: '1000', clicks: '50', spend: '25.00', actions: [{ action_type: 'lead', value: '3' }] }] },
        createdAt: '2026-10-25T01:00:00Z',
      },
      {
        id: 's2',
        tenantId: TENANT,
        bundleId: BUNDLE,
        campaignExternalId: CAMPAIGN_EXT,
        windowStart: '2026-10-25T00:00:00Z',
        windowEnd: '2026-10-26T00:00:00Z',
        metrics: [{ impressions: '800', clicks: '30', spend: '15.00', actions: [{ action_type: 'lead', value: '2' }] }],
        createdAt: '2026-10-26T01:00:00Z',
      },
    ])

    const res = await fetchMetrics()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)

    const item = body.items[0]
    expect(item.bundleId).toBe(BUNDLE)
    expect(item.campaignExternalId).toBe(CAMPAIGN_EXT)
    expect(item.campaignName).toBe('Winter outreach')
    expect(item.adAccountId).toBe(AD_ACCOUNT)
    expect(item.status).toBe('ACTIVE')
    expect(item.impressions).toBe(1800)
    expect(item.clicks).toBe(80)
    expect(item.spend).toBe(40)
    expect(item.leads).toBe(5)
    // costPerLead = 40 / 5 = 8
    expect(item.costPerLead).toBe(8)
    expect(item.recommendation).toBeNull()
    expect(item.lastAnalystRun).toBeNull()
  })

  it('returns zero metrics for a campaign with no snapshots', async () => {
    db.listAllCampaigns.mockResolvedValue([{
      bundleId: BUNDLE,
      campaignExternalId: CAMPAIGN_EXT,
      adAccountId: AD_ACCOUNT,
      campaignName: 'No data campaign',
      status: 'PAUSED',
      analysis: null,
    }])
    metricsDb.listRecentSnapshots.mockResolvedValue([])

    const res = await fetchMetrics()
    expect(res.status).toBe(200)
    const body = await res.json()
    const item = body.items[0]
    expect(item.impressions).toBe(0)
    expect(item.clicks).toBe(0)
    expect(item.spend).toBe(0)
    expect(item.leads).toBe(0)
    expect(item.costPerLead).toBe(0)
    expect(item.status).toBe('PAUSED')
  })

  it('extracts the analyst recommendation from the bundle analysis JSON', async () => {
    const analysis = {
      campaigns: [
        { campaignId: CAMPAIGN_EXT, recommendation: 'scale', reason: 'CPL under threshold' },
        { campaignId: 'camp_other', recommendation: 'kill', reason: 'Spend too high' },
      ],
      message: 'Overall good performance',
    }
    db.listAllCampaigns.mockResolvedValue([{
      bundleId: BUNDLE,
      campaignExternalId: CAMPAIGN_EXT,
      adAccountId: AD_ACCOUNT,
      campaignName: 'Scaled campaign',
      status: 'ACTIVE',
      analysis,
    }])
    metricsDb.listRecentSnapshots.mockResolvedValue([])

    const res = await fetchMetrics()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items[0].recommendation).toBe('scale')
  })

  it('returns null recommendation when the campaign is not in the analysis', async () => {
    const analysis = {
      campaigns: [
        { campaignId: 'camp_different', recommendation: 'hold', reason: 'Stable' },
      ],
    }
    db.listAllCampaigns.mockResolvedValue([{
      bundleId: BUNDLE,
      campaignExternalId: CAMPAIGN_EXT,
      adAccountId: AD_ACCOUNT,
      campaignName: 'Unanalysed campaign',
      status: 'ACTIVE',
      analysis,
    }])
    metricsDb.listRecentSnapshots.mockResolvedValue([])

    const res = await fetchMetrics()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items[0].recommendation).toBeNull()
  })

  it('handles multiple campaigns in one response', async () => {
    db.listAllCampaigns.mockResolvedValue([
      {
        bundleId: BUNDLE,
        campaignExternalId: 'camp_1',
        adAccountId: AD_ACCOUNT,
        campaignName: 'Campaign one',
        status: 'ACTIVE',
        analysis: null,
      },
      {
        bundleId: BUNDLE,
        campaignExternalId: 'camp_2',
        adAccountId: AD_ACCOUNT,
        campaignName: 'Campaign two',
        status: 'PAUSED',
        analysis: null,
      },
    ])
    metricsDb.listRecentSnapshots.mockResolvedValue([
      {
        id: 's1',
        tenantId: TENANT,
        bundleId: BUNDLE,
        campaignExternalId: 'camp_1',
        windowStart: '2026-10-24T00:00:00Z',
        windowEnd: '2026-10-25T00:00:00Z',
        metrics: { data: [{ impressions: '500', clicks: '20', spend: '10.00' }] },
        createdAt: '2026-10-25T01:00:00Z',
      },
    ])

    const res = await fetchMetrics()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(2)
    expect(body.items[0].campaignExternalId).toBe('camp_1')
    expect(body.items[0].impressions).toBe(500)
    expect(body.items[1].campaignExternalId).toBe('camp_2')
    expect(body.items[1].impressions).toBe(0)
  })
})
