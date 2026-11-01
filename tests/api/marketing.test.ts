import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

const db = vi.hoisted(() => ({
  getMarketingBundle: vi.fn(),
  listMarketingArtifacts: vi.fn(),
  listMarketingActions: vi.fn(),
}))

const predictions = vi.hoisted(() => ({
  bundlePredictionGate: vi.fn(),
  insertPrediction: vi.fn(),
}))

vi.mock('../../src/db/marketing', () => ({
  getMarketingBundle: db.getMarketingBundle,
  listMarketingArtifacts: db.listMarketingArtifacts,
  listMarketingActions: db.listMarketingActions,
}))

vi.mock('../../src/db/reviewer-predictions', () => ({
  bundlePredictionGate: predictions.bundlePredictionGate,
  insertPrediction: predictions.insertPrediction,
  getPredictionForDraft: vi.fn(),
}))

// The router imports the stagers from this module, and while marketing-writes is
// being evaluated it reads `MARKETING_ROLES`, `MARKETING_OBJECTIVES` and
// `ARTIFACT_KINDS` from `src/db/marketing` for its `z.enum(...)` schemas. The
// partial db mock above exports none of the three, so the real module cannot
// load against it. Nothing in a GET-route test calls a stager, so the whole
// module is mocked rather than half-loading it through a db shape it does not
// expect.
vi.mock('../../src/mastra/tools/marketing-writes', () => ({
  stagePromotion: vi.fn(),
  stageRetry: vi.fn(),
}))

import { createMarketingRouter } from '../../src/api/marketing'
import { parseEnv } from '../../src/config/env'

const TENANT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const BUNDLE = '33333333-3333-4333-8333-333333333333'

const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'user' }

function router(): Hono {
  return createMarketingRouter({ env: parseEnv({}) })
}

function fetchBundle(id = BUNDLE, headers: Record<string, string> = AUTH) {
  return router().request(`/api/marketing/bundles/${id}`, { headers })
}

beforeEach(() => {
  vi.clearAllMocks()
  predictions.bundlePredictionGate.mockResolvedValue({ required: false, pendingWriteId: null, prediction: null })
})

describe('GET /api/marketing/bundles/:id', () => {
  it('answers with the bundle, its artifacts and its actions', async () => {
    db.getMarketingBundle.mockResolvedValue({ id: BUNDLE, tenantId: TENANT, status: 'staged' })
    db.listMarketingArtifacts.mockResolvedValue([{ id: 'a1', role: 'marketer-copywriter' }])
    db.listMarketingActions.mockResolvedValue([{ id: 'm1', action: 'publish_page' }])
    const res = await fetchBundle()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      bundle: { id: BUNDLE, tenantId: TENANT, status: 'staged' },
      artifacts: [{ id: 'a1', role: 'marketer-copywriter' }],
      actions: [{ id: 'm1', action: 'publish_page' }],
      predictionRequired: false,
      prediction: null,
    })
    expect(db.getMarketingBundle).toHaveBeenCalledWith(TENANT, BUNDLE)
    expect(db.listMarketingActions).toHaveBeenCalledWith(TENANT, BUNDLE)
  })

  it('401s before looking at the path when the identity is rejected', async () => {
    const res = await fetchBundle(BUNDLE, { 'x-user-role': 'auditor' })
    expect(res.status).toBe(401)
    expect(db.getMarketingBundle).not.toHaveBeenCalled()
    expect(db.listMarketingActions).not.toHaveBeenCalled()
  })

  it('400s a id that is not a uuid, without touching the database', async () => {
    const res = await fetchBundle('all-bundles')
    expect(res.status).toBe(400)
    expect(db.getMarketingBundle).not.toHaveBeenCalled()
  })

  it('404s a bundle that is not there or not yours, and cannot tell the two apart', async () => {
    db.getMarketingBundle.mockResolvedValue(null)
    const res = await fetchBundle()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })
})
