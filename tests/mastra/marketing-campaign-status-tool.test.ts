import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockGetOrCreateDraft = vi.fn()
const mockCreateHumanTask = vi.fn()
const mockLoadPolicy = vi.fn()

vi.mock('../../src/db/client', () => ({
  getDbClient: () => ({ query: mockQuery }),
}))

vi.mock('../../src/db/pending-writes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/pending-writes')>()),
  getOrCreateDraft: (...args: unknown[]): Promise<unknown> => mockGetOrCreateDraft(...args) as Promise<unknown>,
  // Stubbed beside the draft for the same reason the promote file stubs it
  // (tests/mastra/marketing-publish-tools.test.ts:25): the tool's catch turns a
  // refusal into a queue entry, and the real insert would reach a database a
  // unit test does not have.
  createHumanTask: (...args: unknown[]): Promise<unknown> => mockCreateHumanTask(...args) as Promise<unknown>,
}))

vi.mock('../../src/governance/policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/governance/policy')>()),
  loadPolicy: (...args: unknown[]): unknown => mockLoadPolicy(...args) as unknown,
}))

import { setCampaignStatusTool, stageCampaignStatusChange } from '../../src/mastra/tools/marketing-writes'
import { registerActionAdapter } from '../../src/marketing/outbox'
import { uuidFromSeed } from '../../src/marketing/hash'

const TENANT = '11111111-1111-4111-8111-111111111111'
const BUNDLE_ID = '33333333-3333-4333-8333-333333333333'
const CAMPAIGN_ID = '23842653876'
const DRAFT_ID = '44444444-4444-4444-8444-444444444444'
// A refusal is answered with a human task id rather than a draft id, so the
// refusal cases need a second constant that cannot be confused with either.
const HUMAN_TASK_ID = '66666666-6666-4666-8666-666666666666'
// requested_by is a uuid column that means "who asked", so every call below has
// to name a person. The cron gets that id from CRUM_ANALYST_USER_ID, and a chat
// caller gets it from the request context.
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
  // A clearAllMocks leaves no resolved value behind, and the refusal path reads
  // one: without it the first refusal case would fail on the stub rather than
  // on the behaviour it is meant to pin.
  mockCreateHumanTask.mockResolvedValue(HUMAN_TASK_ID)
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
    const result = await stageCampaignStatusChange({
      tenantId: TENANT,
      userId: USER,
      bundleId: BUNDLE_ID,
      campaignExternalId: CAMPAIGN_ID,
      status: 'ACTIVE',
      reason: 'cost_per_lead_below_5',
      userRole: 'admin',
    })
    expect(result.pendingWriteId).toBe(DRAFT_ID)
    // The score the draft was created with is carried out, not recomputed: the
    // chat answer that reports a bogus score is worse than one that reports
    // none (plan Step 2, and `draft.riskScore` is an existing field).
    expect(result.riskScore).toBe(10)
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
    const result = await stageCampaignStatusChange({
      tenantId: TENANT,
      userId: USER,
      bundleId: BUNDLE_ID,
      campaignExternalId: CAMPAIGN_ID,
      status: 'ACTIVE',
      reason: 'cost_per_lead_below_5',
      userRole: 'admin',
    })
    expect(result.pendingWriteId).toBe(DRAFT_ID)
    expect(mockGetOrCreateDraft).toHaveBeenCalledTimes(1)
  })

  it('stages PAUSED status for an active campaign (kill recommendation)', async () => {
    // Kill can target any campaign, regardless of current state.
    stubQueries([
      { fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] },
    ])
    const result = await stageCampaignStatusChange({
      tenantId: TENANT,
      userId: USER,
      bundleId: BUNDLE_ID,
      campaignExternalId: CAMPAIGN_ID,
      status: 'PAUSED',
      reason: 'cost_per_lead_above_10',
      userRole: 'admin',
    })
    expect(result.pendingWriteId).toBe(DRAFT_ID)
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
    // The sentence has to say which half of the bug it caught, or a guard that
    // treats a near-miss actor as a missing one passes anyway.
    ).rejects.toThrow(/campaign_status_actor_required.*received nothing/)
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

  it('refuses a malformed actor as well as a missing one', async () => {
    // The task this file belongs to is "the insert always died on 22P02", so the
    // guard has to close the whole bug class rather than the empty case: a
    // near-miss actor is the same rejected cast with a different spelling, and
    // Task 17 forwards a request-context value without parsing it.
    stubQueries([
      { fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] },
    ])
    await expect(
      stageCampaignStatusChange({
        tenantId: TENANT,
        userId: 'analyst-cron',
        bundleId: BUNDLE_ID,
        campaignExternalId: CAMPAIGN_ID,
        status: 'PAUSED',
        reason: 'cost_per_lead_above_10',
        userRole: 'admin',
      }),
    // And the other half: a value that is present but is not a uuid must be named
    // as such, because that is the shape Task 17 forwards unparsed.
    ).rejects.toThrow(/campaign_status_actor_required.*not one/)
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockGetOrCreateDraft).not.toHaveBeenCalled()
  })

  it('pins the derived target id to a literal, not only to a recomputation', () => {
    // Every other assertion compares call.targetId against uuidFromSeed(...)
    // recomputed in the test, so a seed-format change would move both sides
    // together and stay green. This is the one place the format itself is nailed
    // down; the value was measured in two separate processes.
    expect(uuidFromSeed(`campaign:${CAMPAIGN_ID}`)).toBe('ff96fb60-5cb9-8d7d-b265-918605379b58')
  })
})

describe('marketing.set_campaign_status tool', () => {
  // The same context the promote and retry tools are driven with
  // (tests/mastra/marketing-publish-tools.test.ts:33): a plain request-context
  // record and a span runner that just calls the function it is handed.
  const rc = { tenantId: TENANT, userId: USER, bundleId: BUNDLE_ID, userRole: 'admin' }
  const context = {
    requestContext: { all: rc },
    observe: { span: (_name: string, fn: () => Promise<unknown>) => fn() },
  } as never

  type ToolOut = { pendingWriteId: string; riskScore: number; gate: string; message: string }

  it('requireApproval gates on the declared class whatever the placeholder campaign id holds', () => {
    // The hook is synchronous and cannot read a database, so it scores
    // campaignId: '' — the gate still closes because policy/tools.yaml:281
    // declares the tool `approval` and gateFor cannot lower a declared class.
    expect(typeof setCampaignStatusTool.requireApproval).toBe('function')
    // requireApproval is a union with `boolean | undefined` on the tool type,
    // so the callable is taken through an explicit function shape rather than a
    // `!`, which cannot strip the `false` half.
    const gate = setCampaignStatusTool.requireApproval as unknown as (
      input: { status: 'ACTIVE' | 'PAUSED' },
      ctx?: { requestContext?: { all: Record<string, unknown> } },
    ) => boolean
    expect(gate({ status: 'PAUSED' }, { requestContext: { all: rc } })).toBe(true)
  })

  it('execute stages the draft and carries its score and the analyst reason out', async () => {
    stubQueries([
      { fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] },
      { fragment: "action = 'set_campaign_status'", rows: [{ status: 'PAUSED' }] },
    ])
    const out = (await setCampaignStatusTool.execute!(
      {
        bundleId: BUNDLE_ID,
        campaignExternalId: CAMPAIGN_ID,
        status: 'ACTIVE',
        reason: 'cost_per_lead_below_5',
      } as never,
      context,
    )) as unknown as ToolOut
    expect(out.pendingWriteId).toBe(DRAFT_ID)
    // The score is the one the draft was created with, not a recomputation.
    expect(out.riskScore).toBe(10)
    expect(out.gate).toBe('approval')
    // The reason is deliberately absent from the scored payload, so the message
    // is the one place this tool's argument reaches a human.
    expect(out.message).toContain('cost_per_lead_below_5')
    expect(out.message).toContain('Status change to ACTIVE')
    expect(mockCreateHumanTask).not.toHaveBeenCalled()
  })

  it('turns a campaign_not_found throw into a refusal queue entry rather than a rejected turn', async () => {
    stubQueries([{ fragment: "action = 'create_campaign'", rows: [] }])
    const out = (await setCampaignStatusTool.execute!(
      {
        bundleId: BUNDLE_ID,
        campaignExternalId: CAMPAIGN_ID,
        status: 'PAUSED',
        reason: 'cost_per_lead_above_10',
      } as never,
      context,
    )) as unknown as ToolOut
    // The owner reads the prose sentence from REFUSAL_PROSE, not the raw token:
    // that is tokenOf handing the map the part before the colon.
    expect(out.message).toMatch(/no campaign with that id was created by a publish this tenant completed/)
    expect(out.pendingWriteId).toBe(HUMAN_TASK_ID)
    expect(out.riskScore).toBe(0)
    expect(mockGetOrCreateDraft).not.toHaveBeenCalled()
    expect(mockCreateHumanTask).toHaveBeenCalledTimes(1)
    expect(mockCreateHumanTask.mock.calls[0]![1]).toBe('refusal')
  })

  it('turns a campaign_already_active throw into the map-free sentence, one human task, nothing staged', async () => {
    // Brief A3 expected this pin on the actor token, but the tool is not
    // reachable with a near-miss actor: TenantRequestContextSchema
    // (src/mastra/tenant-context.ts:6) validates `userId: z.string().uuid()`
    // on the request context before `execute` runs, and the turn comes back as
    // the framework's "Request context validation failed" message — captured
    // live while this case was written, and reported as an A3 disagreement.
    // campaign_already_active is the entry-free token a real chat turn can
    // produce, so it pins the same machinery: tokenOf takes the part before
    // the colon and the underscore replacement writes the sentence.
    stubQueries([
      { fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] },
      { fragment: "action = 'set_campaign_status'", rows: [{ status: 'ACTIVE' }] },
    ])
    const out = (await setCampaignStatusTool.execute!(
      {
        bundleId: BUNDLE_ID,
        campaignExternalId: CAMPAIGN_ID,
        status: 'ACTIVE',
        reason: 'cost_per_lead_below_5',
      } as never,
      context,
    )) as unknown as ToolOut
    // The closing parenthesis right after the sentence is the proof: the raw
    // throw continues past a colon, so tokenOf stripped the detail.
    expect(out.message).toMatch(/refused \(campaign already active\)/)
    // Exactly one human task, and nothing staged.
    expect(mockCreateHumanTask).toHaveBeenCalledTimes(1)
    expect(mockGetOrCreateDraft).not.toHaveBeenCalled()
    expect(out.pendingWriteId).toBe(HUMAN_TASK_ID)
  })

  it('accepts a 500-character reason and refuses a 501st character', async () => {
    // The reason is the only prose this tool accepts, so its ceiling is the
    // whole difference between an argument and an essay parked in a field.
    const schema = setCampaignStatusTool.inputSchema
    if (!schema) throw new Error('marketing.set_campaign_status has no input schema')
    const base = { bundleId: BUNDLE_ID, campaignExternalId: CAMPAIGN_ID, status: 'PAUSED' }
    const atCeiling = await schema['~standard'].validate({ ...base, reason: 'y'.repeat(500) })
    expect(atCeiling.issues).toBeUndefined()
    const pastIt = await schema['~standard'].validate({ ...base, reason: 'y'.repeat(501) })
    expect(pastIt.issues).toBeDefined()
  })
})
