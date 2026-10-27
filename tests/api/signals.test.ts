// tests/api/signals.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'
import type { Mastra } from '@mastra/core/mastra'
import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context'

/**
 * The three signal routes decide what a signed-in user may do to a conversation
 * that is not currently streaming back to them. The previous suite passed while
 * the real `resolveSession` threw on every call, because each test replaced the
 * whole sessions module — so nothing here exercised identity, ownership, or the
 * context a steered run needs. Both halves are asserted now: the route with a
 * scripted resolve outcome, and the outcome itself in
 * tests/mastra/sessions.test.ts against a real AgentController.
 */
const sessions = vi.hoisted(() => ({ resolveSession: vi.fn() }))

vi.mock('../../src/mastra/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mastra/sessions')>()
  return { ...actual, ...sessions }
})

import { createSignalsRouter, type SignalsRouterDeps } from '../../src/api/signals'
import { parseEnv } from '../../src/config/env'

const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const USER = '660e8400-e29b-41d4-a716-446655440009'
const RESOURCE = `${TENANT}:${USER}`
const THREAD = '770e8400-e29b-41d4-a716-446655440003'

/** dev-mode identity: all three headers, because `resolveIdentity` has no defaults. */
const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

interface Body {
  ok?: boolean
  error?: string
  reason?: string
  detail?: string | string[]
  session_id?: string
  signal?: string
  signal_id?: string
  object_binding?: { objectType: string; objectId: string }
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}

function sessionStub() {
  return {
    abort: vi.fn(),
    steer: vi.fn().mockResolvedValue(undefined),
    // The real `sendSignal` is synchronous and hands back a dispatch promise; a
    // stub that resolved to undefined would let the route pass while ignoring a
    // rejection. The parameter is typed so the call assertions stay checked.
    sendSignal: vi.fn((input: { type: string; contents: string }) => ({
      id: 'sig-1',
      type: input.type,
      accepted: Promise.resolve({ accepted: true }),
    })),
    identity: { getResourceId: () => RESOURCE },
  }
}

function router(over: Partial<SignalsRouterDeps> = {}): Hono {
  return createSignalsRouter({
    env: parseEnv({}),
    getMastra: () => ({ not: 'a real mastra' }) as unknown as Mastra,
    ...over,
  })
}

function post(path: string, body?: unknown, headers: Record<string, string> = AUTH) {
  return router().request(`/api/signals${path}`, {
    method: 'POST',
    headers: { ...headers, 'x-session-id': THREAD, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  sessions.resolveSession.mockResolvedValue({ ok: true, session: sessionStub() })
})

describe('who may signal', () => {
  it('refuses a bare x-tenant-id header instead of trusting it', async () => {
    const res = await post('/interrupt', {}, { 'x-tenant-id': TENANT })

    expect(res.status).toBe(401)
    // Not even reached the session layer.
    expect(sessions.resolveSession).not.toHaveBeenCalled()
  })

  it('resolves the session against the caller\'s own resource, never a header-supplied one', async () => {
    await post('/interrupt', {}, { ...AUTH, 'x-resource-id': 'someone:else' })

    expect(sessions.resolveSession).toHaveBeenCalledWith(
      expect.anything(),
      { sessionId: THREAD, tenantId: TENANT, resourceId: RESOURCE },
    )
  })

  it('requires the conversation handle', async () => {
    const res = await router().request('/api/signals/interrupt', { method: 'POST', headers: AUTH })

    expect(res.status).toBe(400)
    expect((await json<Body>(res)).error).toContain('x-session-id')
  })

  it('answers 503 when no instance is wired rather than inventing a session', async () => {
    const res = await router({ getMastra: () => null }).request('/api/signals/interrupt', {
      method: 'POST',
      headers: { ...AUTH, 'x-session-id': THREAD },
    })

    expect(res.status).toBe(503)
    expect((await json<Body>(res)).error).toBe('agent-not-wired')
  })

  it('gives the same answer for another user\'s session as for one that never existed', async () => {
    sessions.resolveSession.mockResolvedValue({ ok: false, reason: 'wrong-resource' })
    const foreign = await post('/interrupt')
    const foreignBody = await json<Body>(foreign)

    sessions.resolveSession.mockResolvedValue({ ok: false, reason: 'not-started' })
    const missing = await post('/interrupt')

    expect(foreign.status).toBe(404)
    expect(foreignBody.error).toBe('session_not_found')
    // An attacker probing session ids cannot tell the two cases apart.
    expect((await json<Body>(missing)).error).toBe(foreignBody.error)
    expect(foreignBody.detail).not.toMatch(/resource|tenant/i)
  })
})

describe('POST /api/signals/interrupt', () => {
  it('asks the session to stop and reports the request, not a cancelled run', async () => {
    const stub = sessionStub()
    sessions.resolveSession.mockResolvedValue({ ok: true, session: stub })

    const body = await json<Body>(post('/interrupt'))

    expect(stub.abort).toHaveBeenCalled()
    expect(body).toMatchObject({ ok: true, session_id: THREAD, signal: 'interrupt' })
    // `abort()` swallows "no live run", so a field claiming one stopped would lie.
    expect(body).not.toHaveProperty('aborted')
  })
})

describe('POST /api/signals/correct', () => {
  it('rejects an empty correction before touching the session', async () => {
    const res = await post('/correct', { content: '' })

    expect(res.status).toBe(400)
    expect(sessions.resolveSession).not.toHaveBeenCalled()
  })

  it('steers with the identity the tools will need, not a bare context', async () => {
    const stub = sessionStub()
    sessions.resolveSession.mockResolvedValue({ ok: true, session: stub })

    const res = await post('/correct', { content: 'no, the other one' })

    expect(res.status).toBe(200)
    const args = stub.steer.mock.calls[0]![0] as {
      content: string
      requestContext: { get: (k: string) => unknown }
    }
    expect(args.content).toBe('no, the other one')
    // A steered run calls tools, and every tool validates the flat identity
    // convention; an empty context would fail closed after the model was billed.
    expect(args.requestContext.get('tenantId')).toBe(TENANT)
    expect(args.requestContext.get('userId')).toBe(USER)
    expect(args.requestContext.get('userRole')).toBe('admin')
    // The reserved memory keys, by their constants: the steered run has to write
    // to the same thread the chat lane reads.
    expect(args.requestContext.get(MASTRA_RESOURCE_ID_KEY)).toBe(RESOURCE)
    expect(args.requestContext.get(MASTRA_THREAD_ID_KEY)).toBe(THREAD)
  })
})

describe('POST /api/signals/rebind', () => {
  it('refuses an object type the CRM does not have', async () => {
    const res = await post('/rebind', { objectType: 'invoice', objectId: 'inv_1' })

    expect(res.status).toBe(400)
    expect(sessions.resolveSession).not.toHaveBeenCalled()
  })

  it('sends a retained state signal carrying the binding', async () => {
    const stub = sessionStub()
    sessions.resolveSession.mockResolvedValue({ ok: true, session: stub })

    const body = await json<Body>(post('/rebind', { objectType: 'customer', objectId: 'cust_1' }))

    const signal = stub.sendSignal.mock.calls[0]![0]
    expect(signal.type).toBe('state')
    expect(JSON.parse(signal.contents)).toEqual({ objectBinding: { type: 'customer', id: 'cust_1' } })
    expect(body.object_binding).toEqual({ objectType: 'customer', objectId: 'cust_1' })
    // The handle the framework gave the signal, so a caller can correlate it.
    expect(body.signal_id).toBe('sig-1')
  })

  it('reports a rejected dispatch as a failure instead of an ok', async () => {
    const stub = sessionStub()
    stub.sendSignal.mockReturnValue({
      id: 'sig-2',
      type: 'state',
      accepted: Promise.reject(new Error('no agent bound to this session')),
    })
    sessions.resolveSession.mockResolvedValue({ ok: true, session: stub })

    const res = await post('/rebind', { objectType: 'customer', objectId: 'cust_1' })
    const body = await json<Body>(res)

    expect(res.status).toBe(502)
    expect(body.error).toBe('rebind_not_accepted')
    expect(body.ok).toBeUndefined()
  })
})
