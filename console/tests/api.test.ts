import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, describeError, get, post, request } from '../lib/api'

/**
 * `console/lib/api.ts` is the layer that decides whether a failure is visible, so
 * it gets the tests first. The components under test elsewhere mock this module;
 * nothing else checks what it does with a 401 versus a dead port.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Resolve to the rejection, or fail the test if the call unexpectedly succeeded.
 * Typed, because `.catch(e => e as ApiError)` on a `Promise<unknown>` stays
 * `unknown` and every property access below then errors.
 */
async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  return promise.then(
    () => {
      throw new Error('expected the request to fail, and it succeeded')
    },
    (err) => err as ApiError,
  )
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('request', () => {
  it('returns the parsed body on success', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { sessions: [{ id: 't1' }], total: 1 }))
    await expect(get<{ sessions: { id: string }[] }>('/api/agent/threads')).resolves.toEqual({
      sessions: [{ id: 't1' }],
      total: 1,
    })
  })

  it('turns a 401 into an error naming the reason, not just the status', async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(401, { error: 'unauthorized', reason: 'invalid-claim' }),
    )
    const err = await rejection(get('/api/approvals/pending'))
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('unauthorized')
    // 'missing-claim' and 'invalid-claim' point at different mistakes, so the
    // reason has to survive into the message the panel shows.
    expect(err.detail).toContain('invalid-claim')
    expect(describeError(err)).toContain('invalid-claim')
  })

  it('reports an unparseable body as text rather than throwing a parse error', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(500, '<!doctype html><h1>Boom</h1>'))
    const err = await rejection(get('/api/usage'))
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(500)
    expect(err.detail).toContain('Boom')
  })

  it('reports a refused connection as unreachable rather than as an empty list', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'))
    const err = await rejection(get('/api/knowledge/documents'))
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('network_unreachable')
    expect(err.status).toBe(0)
    expect(err.detail).toContain(':4113')
  })

  it('treats 204 as an empty success', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }))
    await expect(request('/api/nothing', { method: 'DELETE' })).resolves.toBeUndefined()
  })
})

describe('header handling', () => {
  it('merges caller headers instead of replacing them', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { ok: true }))
    await post('/api/signals/rebind', { objectType: 'customer', objectId: 'c1' }, { 'x-session-id': 'thread-9' })

    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit
    const headers = init.headers as Record<string, string>
    // The signal routes 400 without `x-session-id`; a spread that overwrote the
    // caller's headers with `Accept` would break every bind silently.
    expect(headers['x-session-id']).toBe('thread-9')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Accept).toBe('application/json')
    expect(init.method).toBe('POST')
  })

  it('never sends an identity claim of its own', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { items: [] }))
    await get('/api/approvals/pending')
    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit
    const headers = (init.headers ?? {}) as Record<string, string>
    // Identity belongs to the middleware. If this ever picks up a tenant claim it
    // has become a client-selectable tenant (§13.2).
    expect(headers['x-tenant-id']).toBeUndefined()
    expect(headers['x-user-id']).toBeUndefined()
  })
})

describe('describeError', () => {
  it('turns the middleware misconfiguration into an instruction', () => {
    const err = new ApiError(503, 'identity-not-configured', 'The console has no dev identity to attach: CRUM_DEV_TENANT_ID')
    expect(describeError(err)).toContain('CRUM_DEV_TENANT_ID')
    expect(describeError(err)).toContain('next dev')
  })

  it('passes a plain bug through unlabelled', () => {
    expect(describeError(new Error('cannot read properties of undefined'))).toContain('cannot read properties')
  })
})
