import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockGetOrCreateDraft = vi.fn()
const mockLoadPolicy = vi.fn()

vi.mock('../../src/db/client', () => ({
  getDbClient: () => ({ query: mockQuery }),
}))

vi.mock('../../src/db/pending-writes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/pending-writes')>()),
  getOrCreateDraft: (...args: unknown[]): Promise<unknown> => mockGetOrCreateDraft(...args) as Promise<unknown>,
}))

vi.mock('../../src/governance/policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/governance/policy')>()),
  loadPolicy: (...args: unknown[]): unknown => mockLoadPolicy(...args) as unknown,
}))

import { stageCampaignStatusChange } from '../../src/mastra/tools/marketing-writes'
import { registerActionAdapter } from '../../src/marketing/outbox'
import { uuidFromSeed } from '../../src/marketing/hash'

const TENANT = '11111111-1111-4111-8111-111111111111'
const BUNDLE_ID = '33333333-3333-4333-8333-333333333333'
const CAMPAIGN_ID = '23842653876'
const DRAFT_ID = '44444444-4444-4444-8444-444444444444'
// requested_by is a uuid column that means "who asked", so every call below has
// to name a person. The cron gets its from CRUM_ANALYST_USER_ID.
const USER = '55555555-5555-4555-8555-555555555555'

type Row = Record<string, unknown>

function stubQueries(handlers: Array<{ fragment: string; rows: Row[] }>): void {
  mockQuery.mockImplementation((sql: string) => {
    for (const handler of handlers) {
      if (sql.includes(handler.fragment)) return Promise.resolve({ rows: handler.rows })
    }
    throw new Error(`unexpected query: ${sql}`)
  })
}

/**
 * A fragment stub answers any parameters and therefore proves nothing about what
 * a query was scoped by, so the call recorder reads the params back out of the
 * mock. Same helper shape as tests/db/marketing-commit.test.ts:76.
 */
function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => (call[0] as string).includes(fragment))
    .map((call) => ({ sql: call[0] as string, params: (call[1] ?? []) as unknown[] }))
}

let unregister: () => void = () => {}

beforeEach(() => {
  // The staging function now refuses an action this process cannot run, so the
  // cases below that expect a draft need an adapter present. registerActionAdapter
  // hands back the unregister so the map goes back exactly as it was found
  // (src/marketing/outbox.ts:69), and afterEach means a failed assertion cannot
  // leak the registration into the refusal case below.
  unregister = registerActionAdapter({
    name: 'set_campaign_status',
    execute: () => Promise.resolve({ externalId: 'x' }),
  })
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

afterEach(() => {
  unregister()
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
      userId: USER,
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
    // target_id is a uuid column and Meta's campaign id is not a uuid, so the
    // draft is keyed by the id derived from it and the real id stays in payload.
    expect(call.targetId).toBe(uuidFromSeed(`campaign:${CAMPAIGN_ID}`))
    expect(call.requestedBy).toBe(USER)
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
      userId: USER,
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
      userId: USER,
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
        userId: USER,
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
        userId: USER,
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
      userId: USER,
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
      userId: USER,
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
    expect(call.targetId).toBe(uuidFromSeed(`campaign:${CAMPAIGN_ID}`))
    expect(call.payload).toEqual({ campaignId: CAMPAIGN_ID, status: 'PAUSED' })
    expect(call.requestedBy).toBe(USER)
    expect(call.idempotencyKey).toBe(`campaign_status:${CAMPAIGN_ID}:PAUSED`)
  })

  it('refuses a call that cannot name an owner, before it spends a query', async () => {
    stubQueries([
      { fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] },
    ])
    await expect(
      stageCampaignStatusChange({
        tenantId: TENANT,
        userId: '',
        bundleId: BUNDLE_ID,
        campaignExternalId: CAMPAIGN_ID,
        status: 'PAUSED',
        reason: 'cost_per_lead_above_10',
        userRole: 'admin',
      }),
    ).rejects.toThrow(/campaign_status_actor_required/)
    // The guard is the cheapest answer, so nothing is read and nothing is staged.
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockGetOrCreateDraft).not.toHaveBeenCalled()
  })

  it('scopes the existence check to the bundle the caller named', async () => {
    stubQueries([
      { fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] },
    ])
    await stageCampaignStatusChange({
      tenantId: TENANT,
      userId: USER,
      bundleId: BUNDLE_ID,
      campaignExternalId: CAMPAIGN_ID,
      status: 'PAUSED',
      reason: 'cost_per_lead_above_10',
      userRole: 'admin',
    })
    // A stub answers any parameters, so the proof is in what was actually bound.
    expect(calls("action = 'create_campaign'").at(-1)!.params).toEqual([TENANT, CAMPAIGN_ID, BUNDLE_ID])
  })

  it('refuses to stage a status change nothing in this process can run', async () => {
    // The point of the guard: an approved draft the drainer cannot execute is an
    // approval that lies, so the door closes before the draft exists.
    unregister()
    stubQueries([
      { fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] },
    ])
    await expect(
      stageCampaignStatusChange({
        tenantId: TENANT,
        userId: USER,
        bundleId: BUNDLE_ID,
        campaignExternalId: CAMPAIGN_ID,
        status: 'PAUSED',
        reason: 'cost_per_lead_above_10',
        userRole: 'admin',
      }),
    ).rejects.toThrow(/provider_not_configured/)
    expect(mockGetOrCreateDraft).not.toHaveBeenCalled()
  })
})
