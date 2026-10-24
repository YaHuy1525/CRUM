// tests/api/feedback.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('POST /api/feedback', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('requires x-tenant-id header', async () => {
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({
        observability: { addFeedback: vi.fn() },
      }),
    }))
    const { createFeedbackRouter } = await import('../../src/api/feedback')
    const app = createFeedbackRouter()

    const res = await app.request('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ traceId: 'trace_123', vote: 'up' }),
    })

    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: string }
    expect(data.error).toMatch(/x-tenant-id/)
  })

  it('calls addFeedback with correct shape', async () => {
    const addFeedback = vi.fn().mockResolvedValue({ id: 'fb_1' })
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({
        observability: { addFeedback },
      }),
    }))

    const { createFeedbackRouter } = await import('../../src/api/feedback')
    const app = createFeedbackRouter()

    const res = await app.request('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'tenant_1' },
      body: JSON.stringify({
        traceId: 'trace_123',
        spanId: 'span_456',
        vote: 'down',
        comment: 'Incorrect answer',
      }),
    })

    expect(res.status).toBe(200)
    expect(addFeedback).toHaveBeenCalledWith({
      traceId: 'trace_123',
      spanId: 'span_456',
      feedback: {
        feedbackType: 'thumbs',
        value: 'down',
        feedbackSource: 'user',
        comment: 'Incorrect answer',
      },
    })
  })

  it('rejects missing traceId', async () => {
    const { createFeedbackRouter } = await import('../../src/api/feedback')
    const app = createFeedbackRouter()

    const res = await app.request('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'tenant_1' },
      body: JSON.stringify({ vote: 'up' }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 500 when addFeedback throws', async () => {
    const addFeedback = vi.fn().mockRejectedValue(new Error('observability down'))
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({
        observability: { addFeedback },
      }),
    }))

    const { createFeedbackRouter } = await import('../../src/api/feedback')
    const app = createFeedbackRouter()

    const res = await app.request('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'tenant_1' },
      body: JSON.stringify({
        traceId: 'trace_err',
        vote: 'up',
      }),
    })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: 'Internal server error' })
  })
})
