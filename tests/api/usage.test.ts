// tests/api/usage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('GET /api/usage', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('requires x-tenant-id header', async () => {
    const { createUsageRouter } = await import('../../src/api/usage')
    const app = createUsageRouter()

    const res = await app.request('/api/usage?from=2026-10-17&to=2026-10-24')

    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toMatch(/x-tenant-id/)
  })

  it('returns usage metrics shape', async () => {
    const queryMetrics = vi.fn().mockResolvedValue({
      tokensIn: 125000,
      tokensOut: 45000,
      cost: 2.34,
      cacheReadTokens: 80000,
      cacheWriteTokens: 20000,
      toolCallCount: 340,
      toolCallErrors: 12,
    })
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({
        storage: { queryMetrics },
      }),
    }))

    const { createUsageRouter } = await import('../../src/api/usage')
    const app = createUsageRouter()

    const res = await app.request('/api/usage?from=2026-10-17&to=2026-10-24', {
      headers: { 'x-tenant-id': 'tenant_1' },
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty('tokensIn')
    expect(data).toHaveProperty('tokensOut')
    expect(data).toHaveProperty('cost')
    expect(data).toHaveProperty('cacheReadTokens')
    expect(data).toHaveProperty('toolCallCount')
  })

  it('returns 503 when metrics are not available', async () => {
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({
        storage: {},
      }),
    }))

    const { createUsageRouter } = await import('../../src/api/usage')
    const app = createUsageRouter()

    const res = await app.request('/api/usage?from=2026-10-17&to=2026-10-24', {
      headers: { 'x-tenant-id': 'tenant_1' },
    })

    expect(res.status).toBe(503)
    const data = await res.json()
    expect(data).toHaveProperty('error')
  })

  it('returns 500 when queryMetrics throws', async () => {
    const queryMetrics = vi.fn().mockRejectedValue(new Error('db connection lost'))
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({
        storage: { queryMetrics },
      }),
    }))

    const { createUsageRouter } = await import('../../src/api/usage')
    const app = createUsageRouter()

    const res = await app.request('/api/usage?from=2026-10-17&to=2026-10-24', {
      headers: { 'x-tenant-id': 'tenant_1' },
    })

    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data).toEqual({ error: 'Internal server error' })
  })
})
