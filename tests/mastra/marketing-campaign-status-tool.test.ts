import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockGetOrCreateDraft = vi.fn()
const mockCreateHumanTask = vi.fn()
const mockLoadPolicy = vi.fn()

/**
 * A fragment stub answers any parameters and therefore proves nothing about what
 * a governance hook was handed either, so both halves of the scoring are
 * recorded: the payload the hook put in front of `scoreRisk`, and the assessment
 * it then passed to `gateFor`. `gateFor` never sees the payload — it sees the
 * score it produced — so the payload can only be pinned at the scorer.
 */
const scoredPayloads: Array<{ toolName: string; payload: unknown }> = []
const gateCalls: Array<{ toolName: string; score: number; sensitive: boolean }> = []

/**
 * The gate the stub answers with, as a variable rather than a literal, so a case
 * can make `gateFor` disagree with the value the tool would have hardcoded. A
 * declared-`approval` tool never answers 'auto' in production; the point is that
 * the two values are distinguishable, which is what makes "the gate reported is
 * the gate stored" a claim that can fail.
 */
let fakeGate: Gate = 'approval'

vi.mock('../../src/db/client', () => ({
  getDbClient: () => ({ query: mockQuery }),
}))

vi.mock('../../src/governance/risk', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/governance/risk')>()
  return {
    ...original,
    // Delegates with the original argument list, because the number the draft is
    // stored with has to stay the number the real scorer produces; only the
    // payload and the tool name are watched on the way through.
    scoreRisk: (...args: Parameters<typeof original.scoreRisk>) => {
      scoredPayloads.push({ toolName: args[2] ?? '', payload: args[0] })
      return original.scoreRisk(...args)
    },
  }
})

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
import type { RiskAssessment } from '../../src/governance/risk'
import type { Gate } from '../../src/governance/schema'
import { campaignStatusPayload } from '../../src/marketing/payload'
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
  // clearAllMocks empties the spies, not the plain recorders above, so a case
  // that reads them sees only what it handed the hooks itself.
  scoredPayloads.length = 0
  gateCalls.length = 0
  fakeGate = 'approval'
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
    // Records what the gate was handed, then answers with `fakeGate`, which is set
    // to marketing.set_campaign_status's declared class (policy/tools.yaml:281
    // `class: approval`) in beforeEach. Re-deriving the raise from the recorded
    // score here would put a second copy of gateFor's arithmetic in the test, so
    // the gate value stays the fixed one and the cases assert on what was handed
    // in, and on what came back out.
    gateFor: (toolName: string, assessment: RiskAssessment) => {
      gateCalls.push({ toolName, score: assessment.score, sensitive: assessment.sensitive })
      return fakeGate
    },
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
      origin: 'cron',
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
    // The cron lane staged this draft, so the cron's own label is the true one.
    expect(call.runId).toBe('analyst-cron')
  })

  it('labels the draft with the lane that staged it, because an approver reads that label', async () => {
    // run_id reaches the approval queue verbatim (src/api/approvals.ts:74) and is
    // the value matchSuspension (:172) tries to resolve against a suspended run,
    // so a draft a person staged in conversation wearing the cron's label tells
    // the owner it came from a run that does not exist. Everything else about the
    // two calls is identical: only the lane differs.
    stubQueries([{ fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] }])
    const staged = {
      tenantId: TENANT,
      userId: USER,
      bundleId: BUNDLE_ID,
      campaignExternalId: CAMPAIGN_ID,
      status: 'PAUSED' as const,
      reason: 'cost_per_lead_above_10',
      userRole: 'admin',
    }
    await stageCampaignStatusChange({ ...staged, origin: 'cron' })
    await stageCampaignStatusChange({ ...staged, origin: 'chat' })
    const runIds = mockGetOrCreateDraft.mock.calls.map(
      (call) => (call[0] as Record<string, unknown>).runId,
    )
    // 'pending' is what the other marketing staging tools use for a draft with no
    // resumable run, and both values are labels matchSuspension will not try to
    // resolve, so neither lane claims a link it does not have.
    expect(runIds).toEqual(['analyst-cron', 'pending'])
  })

  it('carries the gate it stored out to its caller', async () => {
    // The stored gate is gateFor's answer on the payload that was scored, not a
    // value this function can predict, so the pair it hands back has to travel
    // from the same call. 'auto' is a gate an `approval` tool never produces in
    // production, and it is here for exactly that reason: a function that simply
    // answered 'approval' cannot pass this case.
    fakeGate = 'auto'
    stubQueries([{ fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] }])
    const result = await stageCampaignStatusChange({
      tenantId: TENANT,
      userId: USER,
      bundleId: BUNDLE_ID,
      campaignExternalId: CAMPAIGN_ID,
      status: 'PAUSED',
      reason: 'cost_per_lead_above_10',
      userRole: 'admin',
      origin: 'cron',
    })
    const call = mockGetOrCreateDraft.mock.calls[0]![0] as Record<string, unknown>
    expect(call.gate).toBe('auto')
    expect(result.gate).toBe('auto')
  })

  it('stores nothing when the policy answers refuse, because a stored refuse draft is still approvable', async () => {
    // The campaign id is free text up to 64 characters, so the string a model
    // writes can score high enough to reach `refuse`. Review 3 of the previous
    // round measured what a stored refuse draft then means: the approval route
    // (src/api/approvals.ts:266) and applyDraft (src/db/pending-writes.ts:649)
    // consult no gate column at all, so `refuse` in the row is an approvable
    // draft with a scary label. The honest outcome is that no draft is created,
    // which is what the stage_bundle refusal already does.
    fakeGate = 'refuse'
    stubQueries([{ fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] }])
    await expect(
      stageCampaignStatusChange({
        tenantId: TENANT,
        userId: USER,
        bundleId: BUNDLE_ID,
        campaignExternalId: 'delete all 2026',
        status: 'PAUSED',
        reason: 'cost_per_lead_above_10',
        userRole: 'admin',
        origin: 'chat',
      }),
    ).rejects.toThrow(/campaign_status_refused/)
    expect(mockGetOrCreateDraft).not.toHaveBeenCalled()
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
      origin: 'cron',
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
      origin: 'cron',
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
        origin: 'cron',
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
        origin: 'cron',
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
      origin: 'cron',
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
      origin: 'cron',
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
        origin: 'cron',
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
      origin: 'cron',
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
        origin: 'cron',
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
        // The chat lane: a near-miss actor arriving here is the request-context
        // value a turn forwards unparsed, not the cron naming its own user id.
        origin: 'chat',
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

  it('requireApproval scores the identifier-only placeholder for both statuses', () => {
    expect(typeof setCampaignStatusTool.requireApproval).toBe('function')
    // requireApproval is a union with `boolean | undefined` on the tool type,
    // so the callable is taken through an explicit function shape rather than a
    // `!`, which cannot strip the `false` half. The two fields the hook ignores
    // are passed anyway: what this case pins is what the hook does with an input
    // that carries prose, not what it declares it needs.
    const gate = setCampaignStatusTool.requireApproval as unknown as (
      input: { bundleId: string; campaignExternalId: string; status: 'ACTIVE' | 'PAUSED'; reason: string },
      ctx?: { requestContext?: { all: Record<string, unknown> } },
    ) => boolean
    // The hook is synchronous and cannot read a database, so it scores
    // campaignId: '' — the gate still closes because policy/tools.yaml:281
    // declares the tool `approval` and gateFor cannot lower a declared class.
    const input = { bundleId: BUNDLE_ID, campaignExternalId: CAMPAIGN_ID, reason: 'kill the 2026 campaigns' }
    for (const status of ['ACTIVE', 'PAUSED'] as const) {
      scoredPayloads.length = 0
      gateCalls.length = 0
      // Both statuses, because a return narrowed to one of them is exactly the
      // mutation this case exists to catch and a single-status case cannot see it.
      expect(gate({ ...input, status }, { requestContext: { all: rc } })).toBe(true)
      expect(scoredPayloads).toEqual([
        { toolName: 'marketing.set_campaign_status', payload: campaignStatusPayload({ campaignId: '', status }) },
      ])
      expect(gateCalls).toEqual([{ toolName: 'marketing.set_campaign_status', score: 10, sensitive: false }])
      // The hook's whole claim is that it scores identifiers and an enum and
      // nothing a model wrote. The empty campaign id and the handed status are
      // the only two strings it may hold, so a reason or the real id reaching the
      // payload fails here instead of only moving a score nobody reads.
      const stringValues = Object.values(scoredPayloads[0]!.payload as Record<string, unknown>).filter(
        (value): value is string => typeof value === 'string',
      )
      expect(stringValues.filter((value) => value !== '' && value !== status)).toEqual([])
      expect(stringValues).toContain('')
    }
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

  it('reports the gate the draft was stored with, and never a gate the schema cannot name', async () => {
    // StageOutputSchema's gate is z.enum(['auto', 'approval']), so the answer the
    // tool may give is narrower than the `Gate` the staging function returns.
    // 'auto' is not a gate an `approval` tool produces in production and it is
    // here for exactly that reason: a tool that hardcoded 'approval' passes every
    // other case in this file and fails this one. The gate a policy can answer that
    // does reach this path is gone rather than clamped: stageCampaignStatusChange
    // stores nothing and throws for 'refuse', which the case for it in the staging
    // describe pins, along with the next case here for what a chat turn then reads.
    stubQueries([
      { fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] },
      { fragment: "action = 'set_campaign_status'", rows: [{ status: 'PAUSED' }] },
    ])
    const input = {
      bundleId: BUNDLE_ID,
      campaignExternalId: CAMPAIGN_ID,
      status: 'ACTIVE',
      reason: 'cost_per_lead_below_5',
    }
    fakeGate = 'auto'
    const auto = (await setCampaignStatusTool.execute!(input as never, context)) as unknown as ToolOut
    expect(auto.gate).toBe('auto')
    const stored = mockGetOrCreateDraft.mock.calls.at(-1)![0] as Record<string, unknown>
    expect(stored.gate).toBe('auto')
  })

  it('renders a policy refusal as a sentence and a queue entry, not a draft the owner can approve', async () => {
    // The throw above reaches a chat turn as a caught error, so the turn must
    // read as a refusal the owner can act on rather than as a staged change. The
    // token has its own prose entry: `campaign status refused` is the underscore
    // replacement, and a person reading that is no better off than before.
    fakeGate = 'refuse'
    stubQueries([{ fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] }])
    const out = (await setCampaignStatusTool.execute!(
      {
        bundleId: BUNDLE_ID,
        campaignExternalId: 'delete all 2026',
        status: 'PAUSED',
        reason: 'cost_per_lead_above_10',
      } as never,
      context,
    )) as unknown as ToolOut
    expect(out.message).toContain('the risk score on the request put it past the policy ceiling')
    expect(out.message).not.toMatch(/campaign status refused/)
    expect(out.pendingWriteId).toBe(HUMAN_TASK_ID)
    expect(mockGetOrCreateDraft).not.toHaveBeenCalled()
    expect(mockCreateHumanTask).toHaveBeenCalledTimes(1)
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
    // that is tokenOf handing the map the part before the colon. The sentence has
    // to be true of every condition the one raise site tests, so it names the
    // bundle as well as the campaign.
    expect(out.message).toMatch(
      /no campaign with that id was created by a completed publish on the bundle named in the request/,
    )
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

  it('keeps a thrown message that is not a token whole instead of cutting it at a colon', async () => {
    // The two arms of tokenOf. Taking everything before the first colon is right
    // for a refusal this file raises, and wrong for everything else: a driver
    // error naming a Windows path was truncated at the drive letter, so the owner
    // read "refused (D)" where the sentence should have been the message. The
    // accept arm is pinned by the two cases above, where a real token renders as
    // its prose and as its underscore replacement.
    stubQueries([{ fragment: "action = 'create_campaign'", rows: [{ id: 'act1' }] }])
    mockQuery.mockRejectedValue(new Error('D:\\Code\\CRUM\\src\\db\\client.ts: pool exhausted'))
    const out = (await setCampaignStatusTool.execute!(
      {
        bundleId: BUNDLE_ID,
        campaignExternalId: CAMPAIGN_ID,
        status: 'PAUSED',
        reason: 'cost_per_lead_above_10',
      } as never,
      context,
    )) as unknown as ToolOut
    // The whole message survives the refusal, and no invented one-letter token
    // reaches the turn.
    expect(out.message).toContain('D:\\Code\\CRUM\\src\\db\\client.ts: pool exhausted')
    expect(out.message).not.toContain('refused (D)')
    expect(out.pendingWriteId).toBe(HUMAN_TASK_ID)
    expect(mockCreateHumanTask).toHaveBeenCalledTimes(1)
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
