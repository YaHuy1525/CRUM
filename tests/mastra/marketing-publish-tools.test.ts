import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  getMarketingBundle: vi.fn(),
  listPublishSucceeded: vi.fn(),
  currentSiteHash: vi.fn(),
  getFailedAction: vi.fn(),
  getOrCreateDraft: vi.fn(),
  createHumanTask: vi.fn(),
}))

vi.mock('../../src/db/marketing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/marketing')>()),
  getMarketingBundle: db.getMarketingBundle,
  listPublishSucceeded: db.listPublishSucceeded,
  currentSiteHash: db.currentSiteHash,
  getFailedAction: db.getFailedAction,
}))
vi.mock('../../src/db/pending-writes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/pending-writes')>()),
  getOrCreateDraft: db.getOrCreateDraft,
  // Stubbed beside the draft for the same reason: this file is about what a
  // refusal stages and what it does not, and the real insert would reach a
  // database a unit test does not have.
  createHumanTask: db.createHumanTask,
}))

import { promoteBundleTool, stagePromotion, stageRetry } from '../../src/mastra/tools/marketing-writes'
import { registerActionAdapter } from '../../src/marketing/outbox'
import { SlugProblemError } from '../../src/marketing/site'

const rc = { tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', userRole: 'admin' as const }
const context = { requestContext: { all: rc }, observe: { span: (_n: string, fn: () => Promise<unknown>) => fn() } } as never
// A real uuid, because `stagePromotion` refuses anything else before it reads:
// Task 12's REST route will hand it a raw path parameter that no schema guards.
const BUNDLE = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'
const ACT = '66666666-6666-4666-8666-666666666666'
const PUBLISHED = { id: 'act1', siteHash: 'a'.repeat(64) }
const bundle = () => ({
  id: BUNDLE,
  status: 'approved',
  objective: 'inbound_leads',
  funnelPlan: { page: { slug: 's' } },
})

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
    db.getMarketingBundle.mockResolvedValue(bundle())
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
    db.getMarketingBundle.mockResolvedValue(bundle())
    db.listPublishSucceeded.mockResolvedValue([PUBLISHED])
    const out = await stagePromotion({ tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole, bundleId: BUNDLE })
    expect(out).toMatchObject({ ok: false, reason: 'not_executable' })
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
  })

  it('names the action it promotes and re-checks the bytes', async () => {
    const unregister = registerActionAdapter({ name: 'promote_page', execute: () => Promise.resolve({ externalId: 'x' }) })
    db.getMarketingBundle.mockResolvedValue(bundle())
    db.listPublishSucceeded.mockResolvedValue([PUBLISHED])
    db.currentSiteHash.mockResolvedValue('a'.repeat(64))
    const out = await stagePromotion({ tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole, bundleId: BUNDLE })
    expect(out).toMatchObject({ ok: true })
    // The hash is recomputed for this tenant and this bundle. Without this
    // assertion deleting the comparison below leaves this file green, and the
    // comparison is the task's headline invariant.
    expect(db.currentSiteHash).toHaveBeenCalledWith(rc.tenantId, BUNDLE)
    const staged = db.getOrCreateDraft.mock.calls[0]![0] as Record<string, unknown>
    expect(staged.objectType).toBe('marketing_promote')
    expect(staged.payload).toEqual({ bundleId: BUNDLE, pageActionId: 'act1', siteHash: 'a'.repeat(64) })
    expect(Object.keys(staged.payload as object).sort()).toEqual(['bundleId', 'pageActionId', 'siteHash'])
    unregister()
  })

  it('refuses when the current bytes no longer hash to the published preview', async () => {
    const unregister = registerActionAdapter({ name: 'promote_page', execute: () => Promise.resolve({ externalId: 'x' }) })
    db.getMarketingBundle.mockResolvedValue(bundle())
    db.listPublishSucceeded.mockResolvedValue([PUBLISHED])
    // A bundle re-saved since the preview was published: the reviewer approved
    // bytes that are no longer on the page, so nothing may be staged.
    db.currentSiteHash.mockResolvedValue('b'.repeat(64))
    const out = await stagePromotion({ tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole, bundleId: BUNDLE })
    expect(out).toEqual({ ok: false, reason: 'site_hash_moved' })
    expect(db.currentSiteHash).toHaveBeenCalledWith(rc.tenantId, BUNDLE)
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
    unregister()
  })

  it('refuses an id that is not a uuid before reaching the database', async () => {
    // The tool's schema guards this, but the REST route to come will call
    // stagePromotion with a raw path parameter, and a uuid column cannot answer
    // a question asked with something else.
    const out = await stagePromotion({ tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole, bundleId: 'b1' })
    expect(out).toEqual({ ok: false, reason: 'bad_bundle_id' })
    expect(db.getMarketingBundle).not.toHaveBeenCalled()
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
  })

  it('refuses an unpublishable slug as a refusal, not a throw', async () => {
    const unregister = registerActionAdapter({ name: 'promote_page', execute: () => Promise.resolve({ externalId: 'x' }) })
    db.getMarketingBundle.mockResolvedValue(bundle())
    db.listPublishSucceeded.mockResolvedValue([PUBLISHED])
    // currentSiteHash resolves the slug through resolveSite, which throws this
    // instead of returning null. The approval path translates it the same way.
    db.currentSiteHash.mockRejectedValue(new SlugProblemError('Not A Slug'))
    const out = await stagePromotion({ tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole, bundleId: BUNDLE })
    // Its own token: the bytes may be untouched, so a caller may not report
    // which answer it got by reusing site_hash_moved.
    expect(out).toMatchObject({ ok: false, reason: 'slug_unpublishable' })
    if (!out.ok) expect(out.message).toMatch(/Not A Slug/)
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
    unregister()
  })

  it('answers a null live hash as bundle_unavailable, not moved bytes', async () => {
    const unregister = registerActionAdapter({ name: 'promote_page', execute: () => Promise.resolve({ externalId: 'x' }) })
    db.getMarketingBundle.mockResolvedValue(bundle())
    db.listPublishSucceeded.mockResolvedValue([PUBLISHED])
    // A bundle that lost its page, or whose artifacts now sit in an ambiguous
    // slot, has nothing to compare: that is a different problem from a hash
    // that differs, and the owner fixes it somewhere else.
    db.currentSiteHash.mockResolvedValue(null)
    const out = await stagePromotion({ tenantId: rc.tenantId, userId: rc.userId, userRole: rc.userRole, bundleId: BUNDLE })
    expect(out).toEqual({ ok: false, reason: 'bundle_unavailable' })
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
    unregister()
  })
})

describe('marketing.retry_publish', () => {
  it('refuses an id that is not a uuid before reaching the database', async () => {
    // The tool's schema guards this, but Task 12's REST route will call
    // stageRetry with a raw path parameter, and a uuid column cannot answer a
    // question asked with something else.
    const out = await stageRetry({ tenantId: rc.tenantId, userId: rc.userId, userRole: 'admin', actionId: 'b1' })
    expect(out).toEqual({ ok: false, reason: 'bad_action_id' })
    expect(db.getFailedAction).not.toHaveBeenCalled()
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
  })

  it('refuses to retry a row that has not failed', async () => {
    db.getFailedAction.mockResolvedValue(null)
    const out = await stageRetry({ tenantId: rc.tenantId, userId: rc.userId, userRole: 'admin', actionId: ACT })
    expect(out).toMatchObject({ ok: false, reason: 'not_failed' })
  })

  it('refuses when no adapter can execute the failed action', async () => {
    // No adapter registered in this process, the same way a build without the
    // provider configured runs: the refusal has to arrive before anything is
    // staged, because an approval may not exist before its action is executable.
    const unregister = registerActionAdapter({ name: 'publish_page', execute: () => Promise.resolve({ externalId: 'x' }) })
    unregister()
    db.getFailedAction.mockResolvedValue({ id: ACT, bundleId: 'b1', siteHash: 'a'.repeat(64), action: 'publish_page' })
    const out = await stageRetry({ tenantId: rc.tenantId, userId: rc.userId, userRole: 'admin', actionId: ACT })
    expect(out).toEqual({ ok: false, reason: 'not_executable' })
    expect(db.currentSiteHash).not.toHaveBeenCalled()
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
  })

  it('refuses when the bytes moved, so a retry cannot publish an unseen page', async () => {
    // Registered so the refusal under test is the hash, not the build:
    // stageRetry asks whether the action is executable before it compares bytes.
    const unregister = registerActionAdapter({ name: 'publish_page', execute: () => Promise.resolve({ externalId: 'x' }) })
    db.getFailedAction.mockResolvedValue({ id: ACT, bundleId: 'b1', siteHash: 'a'.repeat(64), action: 'publish_page' })
    db.currentSiteHash.mockResolvedValue('b'.repeat(64))
    const out = await stageRetry({ tenantId: rc.tenantId, userId: rc.userId, userRole: 'admin', actionId: ACT })
    expect(out).toMatchObject({ ok: false, reason: 'site_hash_moved' })
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
    unregister()
  })

  it('answers a null live hash as bundle_unavailable, not moved bytes', async () => {
    const unregister = registerActionAdapter({ name: 'publish_page', execute: () => Promise.resolve({ externalId: 'x' }) })
    db.getFailedAction.mockResolvedValue({ id: ACT, bundleId: 'b1', siteHash: 'a'.repeat(64), action: 'publish_page' })
    // No page to hash: the bundle is gone, its plan has no page, or its
    // artifacts sit in an ambiguous slot. None of those is "the bytes moved".
    db.currentSiteHash.mockResolvedValue(null)
    const out = await stageRetry({ tenantId: rc.tenantId, userId: rc.userId, userRole: 'admin', actionId: ACT })
    expect(out).toEqual({ ok: false, reason: 'bundle_unavailable' })
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
    unregister()
  })

  it('refuses an unpublishable slug as a refusal, not a throw', async () => {
    const unregister = registerActionAdapter({ name: 'publish_page', execute: () => Promise.resolve({ externalId: 'x' }) })
    db.getFailedAction.mockResolvedValue({ id: ACT, bundleId: 'b1', siteHash: 'a'.repeat(64), action: 'publish_page' })
    // The same throw the promotion door translates: currentSiteHash resolves the
    // slug through resolveSite, which refuses to return a hash for a slug that
    // cannot name a page. The retry door must answer with its own refusal token,
    // because Task 12 puts both behind REST routes and only one may 500.
    db.currentSiteHash.mockRejectedValue(new SlugProblemError('Not A Slug'))
    const out = await stageRetry({ tenantId: rc.tenantId, userId: rc.userId, userRole: 'admin', actionId: ACT })
    expect(out).toMatchObject({ ok: false, reason: 'slug_unpublishable' })
    if (!out.ok) expect(out.message).toMatch(/Not A Slug/)
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
    unregister()
  })

  it('stages the action id and the hash, and nothing else', async () => {
    db.getFailedAction.mockResolvedValue({ id: ACT, bundleId: 'b1', siteHash: 'a'.repeat(64), action: 'publish_page' })
    db.currentSiteHash.mockResolvedValue('a'.repeat(64))
    const unregister = registerActionAdapter({ name: 'publish_page', execute: () => Promise.resolve({ externalId: 'x' }) })
    const out = await stageRetry({ tenantId: rc.tenantId, userId: rc.userId, userRole: 'admin', actionId: ACT })
    expect(out).toMatchObject({ ok: true })
    expect(Object.keys((db.getOrCreateDraft.mock.calls[0]![0] as { payload: object }).payload).sort())
      .toEqual(['actionId', 'siteHash'])
    unregister()
  })
})
