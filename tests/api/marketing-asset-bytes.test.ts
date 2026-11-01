// tests/api/marketing-asset-bytes.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

const assets = vi.hoisted(() => ({
  getAssetBytes: vi.fn(),
  listBundleIdsForDocument: vi.fn(),
}))

const predictions = vi.hoisted(() => ({
  bundlePredictionGate: vi.fn(),
  insertPrediction: vi.fn(),
}))

vi.mock('../../src/db/marketing-assets', () => ({
  getAssetBytes: assets.getAssetBytes,
  listBundleIdsForDocument: assets.listBundleIdsForDocument,
}))
vi.mock('../../src/db/reviewer-predictions', () => ({
  bundlePredictionGate: predictions.bundlePredictionGate,
  insertPrediction: predictions.insertPrediction,
  getPredictionForDraft: vi.fn(),
}))
vi.mock('../../src/db/marketing', () => ({
  getMarketingBundle: vi.fn(),
  listMarketingArtifacts: vi.fn(),
  listMarketingActions: vi.fn(),
  listAllCampaigns: vi.fn(),
}))
vi.mock('../../src/mastra/tools/marketing-writes', () => ({
  stagePromotion: vi.fn(),
  stageRetry: vi.fn(),
}))

import { createMarketingRouter } from '../../src/api/marketing'
import { parseEnv } from '../../src/config/env'

const TENANT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const DOC = '99999999-9999-4999-8999-999999999999'
const BUNDLE = '33333333-3333-4333-8333-333333333333'

const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'user' }

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function router(): Hono {
  return createMarketingRouter({ env: parseEnv({}) })
}

function fetchBytes(documentId = DOC, headers: Record<string, string> = AUTH) {
  return router().request(`/api/marketing/assets/${documentId}/bytes`, { headers })
}

beforeEach(() => {
  vi.clearAllMocks()
  assets.getAssetBytes.mockResolvedValue({
    kind: 'marketing_asset',
    status: 'needs_review',
    mime: 'image/png',
    data: PNG,
  })
  assets.listBundleIdsForDocument.mockResolvedValue([BUNDLE])
  predictions.bundlePredictionGate.mockResolvedValue({
    required: false,
    prediction: null,
    pendingWriteId: null,
  })
})

describe('GET /api/marketing/assets/:documentId/bytes', () => {
  it('answers with the bytes, the mime and a private cache', async () => {
    const res = await fetchBytes()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
  })

  it('404s a document that is not an asset, rather than 403, so the route cannot probe invoices', async () => {
    assets.getAssetBytes.mockResolvedValue({
      kind: 'invoice',
      status: 'ready',
      mime: 'application/pdf',
      data: PNG,
    })
    const res = await fetchBytes()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('404s a document this tenant does not have', async () => {
    assets.getAssetBytes.mockResolvedValue(null)
    expect((await fetchBytes()).status).toBe(404)
  })

  it('refuses the picture while the owning bundle is gated and unpredicted', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({
      required: true,
      prediction: null,
      pendingWriteId: '44444444-4444-4444-8444-444444444444',
    })
    const res = await fetchBytes()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'prediction_required' })
  })

  it('serves the picture once a prediction exists, even while the gate is open', async () => {
    predictions.bundlePredictionGate.mockResolvedValue({
      required: true,
      prediction: {
        id: '55555555-5555-4555-8555-555555555555',
        tenantId: TENANT,
        pendingWriteId: '44444444-4444-4444-8444-444444444444',
        predictedOutcome: 'six calls',
        createdAt: '2026-11-01T00:00:00.000Z',
      },
      pendingWriteId: '44444444-4444-4444-8444-444444444444',
    })
    expect((await fetchBytes()).status).toBe(200)
  })

  it('checks every bundle the asset is attached to, and refuses if any one is gated', async () => {
    const other = '66666666-6666-4666-8666-666666666666'
    assets.listBundleIdsForDocument.mockResolvedValue([BUNDLE, other])
    predictions.bundlePredictionGate.mockImplementation(
      (_tenant: string, bundleId: string) =>
        bundleId === other
          ? { required: true, prediction: null, pendingWriteId: '44444444-4444-4444-8444-444444444444' }
          : { required: false, prediction: null, pendingWriteId: null },
    )
    const res = await fetchBytes()
    expect(res.status).toBe(409)
    // Both reads happened: an image reused across two campaigns is gated by the
    // stricter of them, not by whichever the query found first.
    expect(predictions.bundlePredictionGate).toHaveBeenCalledTimes(2)
  })

  it('serves an asset attached to nothing, because there is no decision to protect', async () => {
    assets.listBundleIdsForDocument.mockResolvedValue([])
    expect((await fetchBytes()).status).toBe(200)
    expect(predictions.bundlePredictionGate).not.toHaveBeenCalled()
  })

  it('401s without an identity', async () => {
    expect((await fetchBytes(DOC, { 'x-user-role': 'auditor' })).status).toBe(401)
  })

  it('400s a document id that is not a uuid', async () => {
    expect((await fetchBytes('not-a-uuid')).status).toBe(400)
  })
})
