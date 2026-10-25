// tests/api/health.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** The body /health answers with, as asserted field by field in these tests. */
interface HealthPayload {
  status: string
  dependencies: { storage: { status: string; message?: string } }
}

describe('GET /health', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns ok when storage getStatus succeeds', async () => {
    const getStatus = vi.fn().mockResolvedValue(undefined)
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({
        getStorage: () => ({ getStatus }),
      }),
    }))

    const { createHealthRouter } = await import('../../src/api/health')
    const app = createHealthRouter()

    const res = await app.request('/health')

    expect(res.status).toBe(200)
    const data = (await res.json()) as HealthPayload
    expect(data.status).toBe('ok')
    expect(data.dependencies.storage.status).toBe('ok')
    expect(getStatus).toHaveBeenCalled()
  })

  it('returns degraded when storage probe throws', async () => {
    const getStatus = vi.fn().mockRejectedValue(new Error('connection refused'))
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({
        getStorage: () => ({ getStatus }),
      }),
    }))

    const { createHealthRouter } = await import('../../src/api/health')
    const app = createHealthRouter()

    const res = await app.request('/health')

    expect(res.status).toBe(200)
    const data = (await res.json()) as HealthPayload
    expect(data.status).toBe('degraded')
    expect(data.dependencies.storage.status).toBe('degraded')
    expect(data.dependencies.storage.message).toMatch(/connection refused/)
  })

  it('returns degraded when no storage is configured', async () => {
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({
        getStorage: () => undefined,
      }),
    }))

    const { createHealthRouter } = await import('../../src/api/health')
    const app = createHealthRouter()

    const res = await app.request('/health')

    expect(res.status).toBe(200)
    const data = (await res.json()) as HealthPayload
    expect(data.status).toBe('degraded')
    expect(data.dependencies.storage.status).toBe('degraded')
    expect(data.dependencies.storage.message).toMatch(/no storage/)
  })

  it('assumes ok when storage exists but has no getStatus method', async () => {
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({
        getStorage: () => ({}),
      }),
    }))

    const { createHealthRouter } = await import('../../src/api/health')
    const app = createHealthRouter()

    const res = await app.request('/health')

    expect(res.status).toBe(200)
    const data = (await res.json()) as HealthPayload
    expect(data.status).toBe('ok')
    expect(data.dependencies.storage.status).toBe('ok')
  })
})
