import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  getMarketingBundle: vi.fn(),
  listPublishSucceeded: vi.fn(),
  currentSiteHash: vi.fn(),
  getOrCreateDraft: vi.fn(),
  createHumanTask: vi.fn(),
}))

vi.mock('../../src/db/marketing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/marketing')>()),
  getMarketingBundle: db.getMarketingBundle,
  listPublishSucceeded: db.listPublishSucceeded,
  currentSiteHash: db.currentSiteHash,
}))
vi.mock('../../src/db/pending-writes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/pending-writes')>()),
  getOrCreateDraft: db.getOrCreateDraft,
  // Stubbed beside the draft for the same reason: this file is about what a
  // refusal stages and what it does not, and the real insert would reach a
  // database a unit test does not have.
  createHumanTask: db.createHumanTask,
}))

import { promoteBundleTool, stagePromotion } from '../../src/mastra/tools/marketing-writes'
import { registerActionAdapter } from '../../src/marketing/outbox'

const rc = { tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', userRole: 'admin' as const }
const context = { requestContext: { all: rc }, observe: { span: (_n: string, fn: () => Promise<unknown>) => fn() } } as never

beforeEach(() => {
  vi.clearAllMocks()
  // A clearAllMocks leaves no resolved value behind, and the refusal path reads
  // one: without it the first test would fail on the stub rather than on the
  // behaviour it is meant to pin.
  db.createHumanTask.mockResolvedValue('8e8e8e8e-8e8e-4e8e-8e8e-8e8e8e8e8e8e')
  db.getOrCreateDraft.mockResolvedValue({ id: '9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d', riskScore: 10, gate: 'approval', payload: {} })
})

describe('marketing.promote_bundle', () => {
  it('refuses a bundle with no succeeded publish, before staging anything', async () => {
    // A real uuid, because this is the one case that enters through the tool:
    // `bundleId` is `z.string().uuid()` there, so a short id would be refused by
    // the schema and never reach the staging question under test.
    const BUNDLE = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'
    db.getMarketingBundle.mockResolvedValue({ id: BUNDLE, status: 'approved', objective: 'inbound_leads', funnelPlan: { page: { slug: 's' } } })
    db.listPublishSucceeded.mockResolvedValue([])
    const out = await promoteBundleTool.execute!(
      { bundleId: BUNDLE, prompt: '', maxSteps: 1, threadId: 't', thread: null, resourceid: 'r' } as never,
      context,
    )
    expect((out as { message: string }).message).toMatch(/no published preview/)
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
    // A refusal is a queue entry, not a thrown turn: the owner has to be able to
    // read why nothing was staged.
    expect(db.createHumanTask).toHaveBeenCalledTimes(1)
  })

  it('stages identifiers only, and refuses when promote is not executable', async () => {
    const unregister = registerActionAdapter({ name: 'promote_page', execute: () => Promise.resolve({ externalId: 'x' }) })
    unregister()
    db.getMarketingBundle.mockResolvedValue({ id: 'b1', status: 'approved', objective: 'inbound_leads', funnelPlan: { page: { slug: 's' } } })
    db.listPublishSucceeded.mockResolvedValue([{ id: 'act1', siteHash: 'a'.repeat(64) }])
    const out = await stagePromotion({ tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole, bundleId: 'b1' })
    expect(out).toMatchObject({ ok: false, reason: 'not_executable' })
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
  })

  it('names the action it promotes and re-checks the bytes', async () => {
    const unregister = registerActionAdapter({ name: 'promote_page', execute: () => Promise.resolve({ externalId: 'x' }) })
    db.getMarketingBundle.mockResolvedValue({ id: 'b1', status: 'approved', objective: 'inbound_leads', funnelPlan: { page: { slug: 's' } } })
    db.listPublishSucceeded.mockResolvedValue([{ id: 'act1', siteHash: 'a'.repeat(64) }])
    db.currentSiteHash.mockResolvedValue('a'.repeat(64))
    const out = await stagePromotion({ tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole, bundleId: 'b1' })
    expect(out).toMatchObject({ ok: true })
    const staged = db.getOrCreateDraft.mock.calls[0]![0] as Record<string, unknown>
    expect(staged.objectType).toBe('marketing_promote')
    expect(Object.keys(staged.payload as object).sort()).toEqual(['bundleId', 'pageActionId', 'siteHash'])
    unregister()
  })
})
