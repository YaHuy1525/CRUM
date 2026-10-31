import { beforeEach, describe, expect, it, vi } from 'vitest'

const staging = vi.hoisted(() => ({ stagePromotion: vi.fn(), stageRetry: vi.fn() }))

vi.mock('../../src/mastra/tools/marketing-writes', () => ({
  stagePromotion: staging.stagePromotion,
  stageRetry: staging.stageRetry,
}))

import { createMarketingRouter } from '../../src/api/marketing'
import { parseEnv } from '../../src/config/env'

const TENANT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'user' }
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const ACTION = '77777777-7777-4777-8777-777777777777'

function router() {
  return createMarketingRouter({ env: parseEnv({}) })
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/marketing/bundles/:id/promote', () => {
  it('refuses before authenticating nothing: 401 without an identity', async () => {
    const res = await router().request(`/api/marketing/bundles/${BUNDLE}/promote`, { method: 'POST' })
    expect(res.status).toBe(401)
    expect(staging.stagePromotion).not.toHaveBeenCalled()
  })

  it('stages through the same function the tool calls', async () => {
    staging.stagePromotion.mockResolvedValue({ ok: true, pendingWriteId: ACTION, riskScore: 10 })
    const res = await router().request(`/api/marketing/bundles/${BUNDLE}/promote`, { method: 'POST', headers: AUTH })
    expect(res.status).toBe(201)
    // The whole body: the contract is these two keys and no payload, so an
    // echoed brief or a preview URL would fail here rather than ship.
    expect(await res.json()).toEqual({ pendingWriteId: ACTION, riskScore: 10 })
    expect(staging.stagePromotion).toHaveBeenCalledWith({
      tenantId: TENANT, userId: USER, userRole: 'user', bundleId: BUNDLE,
    })
  })

  it('reports a refusal as 409 with the reason, and creates nothing', async () => {
    staging.stagePromotion.mockResolvedValue({ ok: false, reason: 'no_published_preview' })
    const res = await router().request(`/api/marketing/bundles/${BUNDLE}/promote`, { method: 'POST', headers: AUTH })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'not_promotable', reason: 'no_published_preview' })
  })

  it('400s a non-uuid bundle id without calling the stager', async () => {
    const res = await router().request(`/api/marketing/bundles/all-bundles/promote`, { method: 'POST', headers: AUTH })
    expect(res.status).toBe(400)
    expect(staging.stagePromotion).not.toHaveBeenCalled()
  })
})

describe('POST /api/marketing/bundles/:id/actions/:actionId/retry', () => {
  it('401s before the stager when there is no identity', async () => {
    const res = await router().request(`/api/marketing/bundles/${BUNDLE}/actions/${ACTION}/retry`, { method: 'POST' })
    expect(res.status).toBe(401)
    expect(staging.stageRetry).not.toHaveBeenCalled()
  })

  it('reports a refusal as 409 with the reason token intact', async () => {
    staging.stageRetry.mockResolvedValue({ ok: false, reason: 'not_failed' })
    const res = await router().request(`/api/marketing/bundles/${BUNDLE}/actions/${ACTION}/retry`, { method: 'POST', headers: AUTH })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'not_retryable', reason: 'not_failed' })
  })

  it('files the retry under the bundle the path names, and nothing else in the body', async () => {
    staging.stageRetry.mockResolvedValue({ ok: true, pendingWriteId: ACTION, riskScore: 10 })
    const res = await router().request(`/api/marketing/bundles/${BUNDLE}/actions/${ACTION}/retry`, { method: 'POST', headers: AUTH })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ pendingWriteId: ACTION, riskScore: 10 })
    // The path bundle is passed as the expectation, not dropped: the stager keys
    // the row on the action alone, so without this the retry could land under a
    // bundle the path never named.
    expect(staging.stageRetry).toHaveBeenCalledWith({
      tenantId: TENANT, userId: USER, userRole: 'user', actionId: ACTION, expectedBundleId: BUNDLE,
    })
  })

  it('409s a retry whose action belongs to another bundle, and stages nothing', async () => {
    staging.stageRetry.mockResolvedValue({ ok: false, reason: 'bundle_mismatch' })
    const res = await router().request(`/api/marketing/bundles/${BUNDLE}/actions/${ACTION}/retry`, { method: 'POST', headers: AUTH })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'not_retryable', reason: 'bundle_mismatch' })
    expect(staging.stageRetry).toHaveBeenCalledWith({
      tenantId: TENANT, userId: USER, userRole: 'user', actionId: ACTION, expectedBundleId: BUNDLE,
    })
  })

  it('400s a non-uuid action id without calling the stager', async () => {
    const res = await router().request(`/api/marketing/bundles/${BUNDLE}/actions/all-actions/retry`, { method: 'POST', headers: AUTH })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_id' })
    expect(staging.stageRetry).not.toHaveBeenCalled()
  })
})
