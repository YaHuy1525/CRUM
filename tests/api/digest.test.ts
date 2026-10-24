// tests/api/digest.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('GET /api/digest', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  const mockDigestResult = {
    date: '2026-10-24',
    overdue: [{ id: 't1', customer_id: 'c1', label: 'Task 1' }],
    todaySchedule: [{ id: 's1', customer_id: 'c2', label: 'Schedule 1' }],
    staleFollowups: [{ id: 'f1', customer_id: 'c3', label: 'Followup 1' }],
    summary: 'Morning digest: 1 overdue task(s), 1 schedule(s) today, 1 stale followup(s).',
  }

  function mockMastraWorkflow() {
    const start = vi.fn().mockResolvedValue({
      status: 'success',
      result: mockDigestResult,
    })
    const createRun = vi.fn().mockResolvedValue({ start })
    const getWorkflow = vi.fn().mockReturnValue({ createRun })
    return { getWorkflow, createRun, start }
  }

  it('returns 400 when x-tenant-id is missing', async () => {
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({ getWorkflow: vi.fn() }),
    }))
    vi.doMock('../../src/config/env', () => ({
      parseEnv: () => ({}),
    }))

    const { createDigestRouter } = await import('../../src/api/digest')
    const app = createDigestRouter()

    const res = await app.request('/api/digest')

    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: string }
    expect(data.error).toContain('x-tenant-id')
  })

  it('returns digest result on success', async () => {
    const { getWorkflow } = mockMastraWorkflow()
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({ getWorkflow }),
    }))
    vi.doMock('../../src/config/env', () => ({
      parseEnv: () => ({}),
    }))

    const { createDigestRouter } = await import('../../src/api/digest')
    const app = createDigestRouter()

    const res = await app.request('/api/digest', {
      headers: { 'x-tenant-id': 'test-tenant' },
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual(mockDigestResult)
    expect(getWorkflow).toHaveBeenCalledWith('crum-digest')
  })

  it('passes date and staleDays query params to workflow', async () => {
    const { getWorkflow, start } = mockMastraWorkflow()
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({ getWorkflow }),
    }))
    vi.doMock('../../src/config/env', () => ({
      parseEnv: () => ({}),
    }))

    const { createDigestRouter } = await import('../../src/api/digest')
    const app = createDigestRouter()

    const res = await app.request('/api/digest?date=2026-10-20&staleDays=14', {
      headers: { 'x-tenant-id': 'test-tenant' },
    })

    expect(res.status).toBe(200)
    expect(start).toHaveBeenCalledWith({
      inputData: { tenantId: 'test-tenant', date: '2026-10-20', staleDays: 14 },
    })
  })

  it('returns 400 for invalid staleDays', async () => {
    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({ getWorkflow: vi.fn() }),
    }))
    vi.doMock('../../src/config/env', () => ({
      parseEnv: () => ({}),
    }))

    const { createDigestRouter } = await import('../../src/api/digest')
    const app = createDigestRouter()

    const res = await app.request('/api/digest?staleDays=-1', {
      headers: { 'x-tenant-id': 'test-tenant' },
    })

    expect(res.status).toBe(400)
  })

  it('returns 500 when workflow fails', async () => {
    const start = vi.fn().mockResolvedValue({
      status: 'failed',
      error: new Error('db timeout'),
    })
    const createRun = vi.fn().mockResolvedValue({ start })
    const getWorkflow = vi.fn().mockReturnValue({ createRun })

    vi.doMock('../../src/mastra/index', () => ({
      createCrumMastra: () => ({ getWorkflow }),
    }))
    vi.doMock('../../src/config/env', () => ({
      parseEnv: () => ({}),
    }))

    const { createDigestRouter } = await import('../../src/api/digest')
    const app = createDigestRouter()

    const res = await app.request('/api/digest', {
      headers: { 'x-tenant-id': 'test-tenant' },
    })

    expect(res.status).toBe(500)
    const data = (await res.json()) as { error: string }
    expect(data.error).toContain('failed')
  })
})
