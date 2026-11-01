// tests/api/marketing-prediction.test.ts
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
vi.mock('../../src/mastra/tools/marketing-writes', () => ({
  stagePromotion: vi.fn(),
  stageRetry: vi.fn(),
}))

import { createMarketingRouter } from '../../src/api/marketing'
import { parseEnv } from '../../src/config/env'

const TENANT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const DRAFT = '44444444-4444-4444-8444-444444444444'
const PREDICTION = '55555555-5555-4555-8555-555555555555'

const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'user' }

const gated = {
  id: BUNDLE,
  tenantId: TENANT,
  brief: 'Book more assessment calls with Melbourne physio clinics',
  objective: 'inbound_leads',
  audienceNote: 'owner-led clinics',
  status: 'staged',
  strategy: { position: 'the clinic that answers within the hour' },
  copy: { hooks: ['Your next patient is already searching'] },
  mediaPlan: { budget: 400 },
  funnelPlan: { page: { slug: 'free-scan' } },
  analysis: null,
  promptVersion: 'marketing-v1',
  draftHash: 'hash',
  leadToken: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
}

const prediction = {
  id: PREDICTION,
  tenantId: TENANT,
  pendingWriteId: DRAFT,
  predictedOutcome: 'about 6 booked calls a week',
  createdAt: '2026-11-01T00:00:00.000Z',
}

function router(): Hono {
  return createMarketingRouter({ env: parseEnv({}) })
}

function getBundle(headers: Record<string, string> = AUTH) {
  return router().request(`/api/marketing/bundles/${BUNDLE}`, { headers })
}

function post(body: unknown, headers: Record<string, string> = AUTH) {
  return router().request(`/api/marketing/bundles/${BUNDLE}/prediction`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  db.getMarketingBundle.mockResolvedValue(gated)
  db.listMarketingArtifacts.mockResolvedValue([{ id: 'a1', kind: 'image', documentId: 'd1' }])
  db.listMarketingActions.mockResolvedValue([])
  predictions.bundlePredictionGate.mockResolvedValue({ required: false, pendingWriteId: null, prediction: null })
})

describe('GET /api/marketing/bundles/:id withholds the proposal', () => {
  it('answers normally with the two new fields when the bundle is not gated', async () => {
    const body = await (await getBundle()).json() as {
      predictionRequired: boolean
      prediction: unknown
      artifacts: unknown[]
      bundle: { copy: unknown }
    }
    expect(body.predictionRequired).toBe(false)
    expect(body.prediction).toBeNull()
    expect(body.artifacts).toHaveLength(1)
    expect(body.bundle.copy).not.toBeUndefined()
  })

  it('drops every prose-bearing key and the artifact list while a gate is open', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({ required: true, pendingWriteId: DRAFT, prediction: null })
    const res = await getBundle()
    const body = await res.json() as {
      predictionRequired: boolean
      bundle: Record<string, unknown>
      actions: unknown[]
    }
    expect(res.status).toBe(200)
    expect(body.predictionRequired).toBe(true)
    // Absent, not null: a null where an object belongs still tells a reader the
    // field exists and is empty, which is a fact about the proposal.
    for (const key of ['strategy', 'copy', 'mediaPlan', 'funnelPlan', 'analysis', 'audienceNote']) {
      expect(Object.keys(body.bundle)).not.toContain(key)
    }
    expect(Object.keys(body)).not.toContain('artifacts')
    // What survives is what tells the reviewer which bundle they are looking at.
    expect(body.bundle.brief).toBe(gated.brief)
    expect(body.bundle.id).toBe(BUNDLE)
    expect(body.bundle.status).toBe('staged')
    expect(body.bundle.createdAt).toBe(gated.createdAt)
    expect(body.actions).toEqual([])
    // And the withheld read never happens, so the artifacts are not fetched and
    // then filtered — they are not fetched.
    expect(db.listMarketingArtifacts).not.toHaveBeenCalled()
  })

  it('shows the whole bundle once a prediction exists, and says the gate is still open', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({ required: true, pendingWriteId: DRAFT, prediction })
    const body = await (await getBundle()).json() as {
      predictionRequired: boolean
      prediction: unknown
      artifacts: unknown[]
      bundle: { copy: unknown }
    }
    expect(body.predictionRequired).toBe(true)
    expect(body.prediction).toEqual(prediction)
    expect(body.artifacts).toHaveLength(1)
    expect(body.bundle.copy).toEqual(gated.copy)
  })

  it('refuses an unauthenticated read the same way its sibling routes do', async () => {
    const res = await getBundle({ 'x-user-role': 'auditor' })
    expect(res.status).toBe(401)
    expect(predictions.bundlePredictionGate).not.toHaveBeenCalled()
  })
})

describe('POST /api/marketing/bundles/:id/prediction', () => {
  it('stores the outcome against the open stage draft and answers 200', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({ required: true, pendingWriteId: DRAFT, prediction: null })
    predictions.insertPrediction.mockResolvedValue({ created: true, prediction })
    const res = await post({ predictedOutcome: 'about 6 booked calls a week' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ prediction, existed: false })
    expect(predictions.insertPrediction).toHaveBeenCalledWith({
      tenantId: TENANT,
      pendingWriteId: DRAFT,
      predictedOutcome: 'about 6 booked calls a week',
    })
  })

  it('answers 409 prediction_bundle_not_staged when no open stage draft exists', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({ required: false, pendingWriteId: null, prediction: null })
    const res = await post({ predictedOutcome: 'six calls' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'prediction_bundle_not_staged' })
    expect(predictions.insertPrediction).not.toHaveBeenCalled()
  })

  it('answers 400 prediction_required_text on whitespace, and writes nothing', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({ required: true, pendingWriteId: DRAFT, prediction: null })
    const res = await post({ predictedOutcome: '   ' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'prediction_required_text' })
    expect(predictions.insertPrediction).not.toHaveBeenCalled()
  })

  it('answers 400 prediction_required_text when the field is missing altogether', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({ required: true, pendingWriteId: DRAFT, prediction: null })
    expect((await post({})).status).toBe(400)
    expect(predictions.insertPrediction).not.toHaveBeenCalled()
  })

  it('hands the existing prediction back with existed true instead of failing a second reviewer', async () => {
    // Two tabs, one draft. The loser did not do anything wrong, and the row that
    // is stored is the row they need to see.
    predictions.bundlePredictionGate.mockResolvedValue({ required: true, pendingWriteId: DRAFT, prediction })
    const res = await post({ predictedOutcome: 'mine' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ prediction, existed: true })
    expect(predictions.insertPrediction).not.toHaveBeenCalled()
  })

  it('caps the outcome length so a paste of the whole bundle is not a prediction', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({ required: true, pendingWriteId: DRAFT, prediction: null })
    const res = await post({ predictedOutcome: 'x'.repeat(2001) })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'prediction_required_text' })
  })

  it('404s a bundle the tenant cannot see before it asks about gates', async () => {
    db.getMarketingBundle.mockResolvedValue(null)
    const res = await post({ predictedOutcome: 'six calls' })
    expect(res.status).toBe(404)
    expect(predictions.bundlePredictionGate).not.toHaveBeenCalled()
  })

  it('401s without an identity, the same door as the GET', async () => {
    const res = await post({ predictedOutcome: 'six calls' }, { 'x-user-role': 'auditor' })
    expect(res.status).toBe(401)
  })
})
