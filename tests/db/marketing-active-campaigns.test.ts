// tests/db/marketing-active-campaigns.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockPool = { query: mockQuery, end: vi.fn() }

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://test:test@localhost:5432/testdb', NODE_ENV: 'test' }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const BUNDLE_A = '33333333-3333-4333-8333-333333333333'
const BUNDLE_B = '44444444-4444-4444-8444-444444444444'
const CAMPAIGN_A = '23842653876'
const CAMPAIGN_B = '23842653877'
const AD_ACCOUNT = 'act_123456'

function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => (call[0] as string).includes(fragment))
    .map((call) => ({ sql: call[0] as string, params: (call[1] ?? []) as unknown[] }))
}

async function load() {
  return await import('../../src/db/marketing')
}

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
})

describe('listActiveCampaigns', () => {
  it('returns campaigns with no status changes as active', async () => {
    // First query: create_campaign actions
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          bundle_id: BUNDLE_A,
          campaignExternalId: CAMPAIGN_A,
          adAccountId: AD_ACCOUNT,
        },
      ],
    })
    // Second query: set_campaign_status for CAMPAIGN_A — none
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { listActiveCampaigns } = await load()
    const result = await listActiveCampaigns(TENANT)

    expect(result).toEqual([
      { bundleId: BUNDLE_A, campaignExternalId: CAMPAIGN_A, adAccountId: AD_ACCOUNT },
    ])

    const createCalls = calls("action = 'create_campaign'")
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]!.sql).toContain("status = 'succeeded'")
    expect(createCalls[0]!.params).toEqual([TENANT])

    const statusCalls = calls("action = 'set_campaign_status'")
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0]!.params).toEqual([TENANT, CAMPAIGN_A])
  })

  it('returns campaigns whose most recent status is ACTIVE', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          bundle_id: BUNDLE_A,
          campaignExternalId: CAMPAIGN_A,
          adAccountId: AD_ACCOUNT,
        },
      ],
    })
    // Most recent set_campaign_status is ACTIVE
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'ACTIVE' }],
    })

    const { listActiveCampaigns } = await load()
    const result = await listActiveCampaigns(TENANT)

    expect(result).toEqual([
      { bundleId: BUNDLE_A, campaignExternalId: CAMPAIGN_A, adAccountId: AD_ACCOUNT },
    ])

    const statusCalls = calls("action = 'set_campaign_status'")
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0]!.sql).toContain('ORDER BY created_at DESC')
    expect(statusCalls[0]!.sql).toContain('LIMIT 1')
  })

  it('excludes campaigns whose most recent status is PAUSED', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          bundle_id: BUNDLE_A,
          campaignExternalId: CAMPAIGN_A,
          adAccountId: AD_ACCOUNT,
        },
      ],
    })
    // Most recent set_campaign_status is PAUSED
    mockQuery.mockResolvedValueOnce({
      rows: [{ status: 'PAUSED' }],
    })

    const { listActiveCampaigns } = await load()
    const result = await listActiveCampaigns(TENANT)

    expect(result).toEqual([])
  })

  it('excludes campaigns with no succeeded create_campaign action', async () => {
    // No create_campaign rows with status = 'succeeded'
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { listActiveCampaigns } = await load()
    const result = await listActiveCampaigns(TENANT)

    expect(result).toEqual([])
    // No status queries should have been made
    const statusCalls = calls("action = 'set_campaign_status'")
    expect(statusCalls).toHaveLength(0)
  })

  it('returns empty array for tenant with no campaigns', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { listActiveCampaigns } = await load()
    const result = await listActiveCampaigns(TENANT)

    expect(result).toEqual([])
  })

  it('handles multiple campaigns, filtering paused ones', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          bundle_id: BUNDLE_A,
          campaignExternalId: CAMPAIGN_A,
          adAccountId: AD_ACCOUNT,
        },
        {
          bundle_id: BUNDLE_B,
          campaignExternalId: CAMPAIGN_B,
          adAccountId: AD_ACCOUNT,
        },
      ],
    })
    // CAMPAIGN_A: no status change → active
    mockQuery.mockResolvedValueOnce({ rows: [] })
    // CAMPAIGN_B: most recent status PAUSED → excluded
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'PAUSED' }] })

    const { listActiveCampaigns } = await load()
    const result = await listActiveCampaigns(TENANT)

    expect(result).toEqual([
      { bundleId: BUNDLE_A, campaignExternalId: CAMPAIGN_A, adAccountId: AD_ACCOUNT },
    ])
  })

  it('skips create_campaign rows with null campaignExternalId', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          bundle_id: BUNDLE_A,
          campaignExternalId: null,
          adAccountId: AD_ACCOUNT,
        },
      ],
    })

    const { listActiveCampaigns } = await load()
    const result = await listActiveCampaigns(TENANT)

    expect(result).toEqual([])
    // No status query should have been made for null externalId
    const statusCalls = calls("action = 'set_campaign_status'")
    expect(statusCalls).toHaveLength(0)
  })
})
