import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockGetOrCreateDraft = vi.fn()
const mockLoadPolicy = vi.fn()

vi.mock('../../src/db/client', () => ({
  getDbClient: () => ({ query: mockQuery }),
}))

vi.mock('../../src/db/pending-writes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/pending-writes')>()),
  getOrCreateDraft: (...args: unknown[]) => mockGetOrCreateDraft(...args),
}))

vi.mock('../../src/governance/policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/governance/policy')>()),
  loadPolicy: (...args: unknown[]) => mockLoadPolicy(...args),
}))

import { stageCampaignStatusChange } from '../../src/mastra/tools/marketing-writes'

const TENANT = '11111111-1111-4111-8111-111111111111'
const BUNDLE_ID = '33333333-3333-4333-8333-333333333333'
const CAMPAIGN_ID = '23842653876'
const DRAFT_ID = '44444444-4444-4444-8444-444444444444'

type Row = Record<string, unknown>

function stubQueries(handlers: Array<{ fragment: string; rows: Row[] }>): void {
  mockQuery.mockImplementation((sql: string) => {
    for (const handler of handlers) {
      if (sql.includes(handler.fragment)) return Promise.resolve({ rows: handler.rows })
    }
    throw new Error(`unexpected query: ${sql}`)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLoadPolicy.mockReturnValue({
    risk: {
      preflight: {
        irreversible_terms: [],
        high_blast_terms: [],
        domains: {},
        scores: { benign: 10, single_risk: 40, irreversible_high_blast: 80 },
        gates: { approval_at: 50, refuse_at: 80 },
      },
      sensitive: { markers: [], clause: '', required_gate: 'approval' as const },
    },
    gateFor: () => 'approval' as const,
  })
  mockGetOrCreateDraft.mockResolvedValue({
    id: DRAFT_ID,
    riskScore: 10,
    gate: 'approval',
    payload: {},
  })
})

describe('stageCampaignStatusChange', () => {
  it('stages ACTIVE status for a paused campaign (scale recommendation)', async () => {
    // Campaign exists (create_campaign succeeded) and is currently paused.
    stubQueries([
      { fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] },
      { fragment: "action = 'set_campaign_status'", rows: [{ status: 'PAUSED' }] },
    ])
    const draftId = await stageCampaignStatusChange({
      tenantId: TENANT,
      bundleId: BUNDLE_ID,
      campaignExternalId: CAMPAIGN_ID,
      status: 'ACTIVE',
      reason: 'cost_per_lead_below_5',
      userRole: 'admin',
    })
    expect(draftId).toBe(DRAFT_ID)
    // The draft was created with the correct object type and payload.
    const call = mockGetOrCreateDraft.mock.calls[0]![0] as Record<string, unknown>
    expect(call.objectType).toBe('marketing_set_campaign_status')
    expect(call.payload).toEqual({ campaignId: CAMPAIGN_ID, status: 'ACTIVE' })
    expect(call.operation).toBe('update')
    expect(call.targetId).toBe(CAMPAIGN_ID)
    expect(call.requestedBy).toBe('analyst-cron')
    expect(call.runId).toBe('analyst-cron')
  })

  it('stages ACTIVE status when no set_campaign_status exists (initial paused state)', async () => {
    // Campaign exists and has never had a status change (still in initial paused state).
    stubQueries([
      { fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] },
      { fragment: "action = 'set_campaign_status'", rows: [] },
    ])
    const draftId = await stageCampaignStatusChange({
      tenantId: TENANT,
      bundleId: BUNDLE_ID,
      campaignExternalId: CAMPAIGN_ID,
      status: 'ACTIVE',
      reason: 'cost_per_lead_below_5',
      userRole: 'admin',
    })
    expect(draftId).toBe(DRAFT_ID)
    expect(mockGetOrCreateDraft).toHaveBeenCalledTimes(1)
  })

  it('stages PAUSED status for an active campaign (kill recommendation)', async () => {
    // Kill can target any campaign, regardless of current state.
    stubQueries([
      { fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] },
    ])
    const draftId = await stageCampaignStatusChange({
      tenantId: TENANT,
      bundleId: BUNDLE_ID,
      campaignExternalId: CAMPAIGN_ID,
      status: 'PAUSED',
      reason: 'cost_per_lead_above_10',
      userRole: 'admin',
    })
    expect(draftId).toBe(DRAFT_ID)
    const call = mockGetOrCreateDraft.mock.calls[0]![0] as Record<string, unknown>
    expect(call.payload).toEqual({ campaignId: CAMPAIGN_ID, status: 'PAUSED' })
    // PAUSED does not query set_campaign_status: the kill door accepts any state.
    // Only one query ran (the create_campaign check).
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('refuses ACTIVE status for an already active campaign', async () => {
    stubQueries([
      { fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] },
      { fragment: "action = 'set_campaign_status'", rows: [{ status: 'ACTIVE' }] },
    ])
    await expect(
      stageCampaignStatusChange({
        tenantId: TENANT,
        bundleId: BUNDLE_ID,
        campaignExternalId: CAMPAIGN_ID,
        status: 'ACTIVE',
        reason: 'cost_per_lead_below_5',
        userRole: 'admin',
      }),
    ).rejects.toThrow(/campaign_already_active/)
    expect(mockGetOrCreateDraft).not.toHaveBeenCalled()
  })

  it('refuses if campaign does not exist (no create_campaign action)', async () => {
    stubQueries([
      { fragment: "action = 'create_campaign'", rows: [] },
    ])
    await expect(
      stageCampaignStatusChange({
        tenantId: TENANT,
        bundleId: BUNDLE_ID,
        campaignExternalId: CAMPAIGN_ID,
        status: 'PAUSED',
        reason: 'cost_per_lead_above_10',
        userRole: 'admin',
      }),
    ).rejects.toThrow(/campaign_not_found/)
    expect(mockGetOrCreateDraft).not.toHaveBeenCalled()
  })

  it('computes the risk score through scoreRisk on the payload', async () => {
    stubQueries([
      { fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] },
    ])
    await stageCampaignStatusChange({
      tenantId: TENANT,
      bundleId: BUNDLE_ID,
      campaignExternalId: CAMPAIGN_ID,
      status: 'PAUSED',
      reason: 'cost_per_lead_above_10',
      userRole: 'admin',
    })
    // loadPolicy was called to obtain the risk config for scoreRisk.
    expect(mockLoadPolicy).toHaveBeenCalled()
    // The draft was created with a numeric risk score.
    const call = mockGetOrCreateDraft.mock.calls[0]![0] as Record<string, unknown>
    expect(typeof call.riskScore).toBe('number')
  })

  it('inserts the correct pending_writes row via getOrCreateDraft', async () => {
    stubQueries([
      { fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] },
    ])
    await stageCampaignStatusChange({
      tenantId: TENANT,
      bundleId: BUNDLE_ID,
      campaignExternalId: CAMPAIGN_ID,
      status: 'PAUSED',
      reason: 'cost_per_lead_above_10',
      userRole: 'admin',
    })
    const call = mockGetOrCreateDraft.mock.calls[0]![0] as Record<string, unknown>
    expect(call.tenantId).toBe(TENANT)
    expect(call.objectType).toBe('marketing_set_campaign_status')
    expect(call.operation).toBe('update')
    expect(call.targetId).toBe(CAMPAIGN_ID)
    expect(call.payload).toEqual({ campaignId: CAMPAIGN_ID, status: 'PAUSED' })
    expect(call.requestedBy).toBe('analyst-cron')
    expect(call.idempotencyKey).toBe(`campaign_status:${CAMPAIGN_ID}:PAUSED`)
  })
})
