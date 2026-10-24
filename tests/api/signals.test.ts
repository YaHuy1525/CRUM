// tests/api/signals.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('POST /api/signals/interrupt', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('requires x-tenant-id header', async () => {
    const { createSignalsRouter } = await import('../../src/api/signals')
    const app = createSignalsRouter()
    const res = await app.request('/api/signals/interrupt', { method: 'POST' })
    expect(res.status).toBe(400)
  })

  it('calls session.abort() and returns 200', async () => {
    const abort = vi.fn()
    vi.doMock('../../src/mastra/sessions', () => ({
      resolveSession: () => ({ session: { abort } }),
    }))
    const { createSignalsRouter } = await import('../../src/api/signals')
    const app = createSignalsRouter()
    const res = await app.request('/api/signals/interrupt', {
      method: 'POST',
      headers: { 'x-tenant-id': 't1', 'x-session-id': 's1' },
    })
    expect(res.status).toBe(200)
    expect(abort).toHaveBeenCalled()
  })
})

describe('POST /api/signals/correct', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('requires content in body', async () => {
    const { createSignalsRouter } = await import('../../src/api/signals')
    const app = createSignalsRouter()
    const res = await app.request('/api/signals/correct', {
      method: 'POST',
      headers: { 'x-tenant-id': 't1', 'x-session-id': 's1', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('calls session.steer() with content', async () => {
    const steer = vi.fn()
    vi.doMock('../../src/mastra/sessions', () => ({
      resolveSession: () => ({ session: { steer } }),
    }))
    const { createSignalsRouter } = await import('../../src/api/signals')
    const app = createSignalsRouter()
    const res = await app.request('/api/signals/correct', {
      method: 'POST',
      headers: { 'x-tenant-id': 't1', 'x-session-id': 's1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'no, the other one' }),
    })
    expect(res.status).toBe(200)
    expect(steer).toHaveBeenCalledWith({ content: 'no, the other one' })
  })
})

describe('POST /api/signals/rebind', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('calls session.sendSignal() with objectBinding', async () => {
    const sendSignal = vi.fn()
    vi.doMock('../../src/mastra/sessions', () => ({
      resolveSession: () => ({ session: { sendSignal } }),
    }))
    const { createSignalsRouter } = await import('../../src/api/signals')
    const app = createSignalsRouter()
    const res = await app.request('/api/signals/rebind', {
      method: 'POST',
      headers: { 'x-tenant-id': 't1', 'x-session-id': 's1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ objectType: 'customer', objectId: 'cust_1' }),
    })
    expect(res.status).toBe(200)
    expect(sendSignal).toHaveBeenCalled()
    const signalArg = sendSignal.mock.calls[0][0]
    expect(signalArg.type).toBe('state')
  })
})
