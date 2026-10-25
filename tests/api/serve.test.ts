// tests/api/serve.test.ts
import { describe, expect, it, vi } from 'vitest'
import type { Mastra } from '@mastra/core/mastra'
import { createApiApp, MAX_BODY_BYTES, startApiServer } from '../../src/api/serve'
import { parseEnv } from '../../src/config/env'

/**
 * `src/api/serve.ts` is the only thing that makes the `/api` plane reachable at
 * all: every other file in this directory was exercised through
 * `router.request()`, which proves a router works but not that anything mounts
 * it. These tests are about the composition — is each router actually attached,
 * does a miss answer as data rather than as a page, does the socket bind and
 * release.
 */
function app(getMastra: () => Mastra | null = () => null) {
  return createApiApp({ env: parseEnv({}), getMastra })
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}

/** Everything the handoff lists as the plane's surface, with its real method. */
const MOUNTED: Array<{ method: 'GET' | 'POST'; path: string }> = [
  { method: 'GET', path: '/health' },
  { method: 'POST', path: '/api/feedback' },
  { method: 'GET', path: '/api/usage' },
  { method: 'GET', path: '/api/digest' },
  { method: 'POST', path: '/api/crm/prefill/customer' },
  { method: 'GET', path: '/api/crm/customers/550e8400-e29b-41d4-a716-446655440000' },
  { method: 'POST', path: '/api/signals/interrupt' },
  { method: 'GET', path: '/api/agent/threads' },
  { method: 'GET', path: '/api/approvals/pending' },
  { method: 'GET', path: '/api/approvals/resolved' },
  { method: 'POST', path: '/api/knowledge/upload' },
  { method: 'GET', path: '/api/knowledge/documents' },
]

describe('mount table', () => {
  it.each(MOUNTED)('$method $path is mounted on the plane', async ({ method, path }) => {
    const res = await app().request(path, { method })

    // Any answer but "no such route". The status itself belongs to the router's
    // own suite; here the only failure mode is a router nobody attached.
    expect(res.status).not.toBe(404)
  })

  it('answers an unmatched path as JSON, because a browser fetch reads bodies not statuses', async () => {
    const res = await app().request('/api/nothing/here')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await json<{ error?: string; detail?: string }>(res)
    expect(body.error).toBe('not_found')
    expect(body.detail).toContain('/api/nothing/here')
  })

  it('refuses a declared body over the ceiling before any router reads it', async () => {
    const res = await app().request('/api/feedback', {
      method: 'POST',
      headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
      body: '{}',
    })

    expect(res.status).toBe(413)
    expect((await json<{ error?: string }>(res)).error).toBe('payload_too_large')
  })

  it('turns a route that throws into a JSON 500, not the framework text response', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    // The signal routes call the getter outside any try/catch: a registry getter
    // that throws is a programming fault, and a 500 is the honest answer.
    const exploded = app(() => {
      throw new Error('registry exploded')
    })

    const res = await exploded.request('/api/signals/interrupt', {
      method: 'POST',
      headers: {
        'x-tenant-id': '550e8400-e29b-41d4-a716-446655440000',
        'x-user-id': '660e8400-e29b-41d4-a716-446655440009',
        'x-user-role': 'admin',
        'x-session-id': '770e8400-e29b-41d4-a716-446655440003',
      },
    })

    expect(res.status).toBe(500)
    expect(await json<{ error?: string; detail?: string }>(res)).toMatchObject({
      error: 'internal_error',
      detail: 'registry exploded',
    })
    // Logged with the path, or the 500 is undiscoverable from the server side.
    expect(consoleError.mock.calls.map((call) => call.join(' ')).join('\n')).toMatch(/POST \/api\/signals\/interrupt/)
    consoleError.mockRestore()
  })
})

describe('binding the socket', () => {
  it('listens, answers over http, and releases the port', async () => {
    // Port 0: an ephemeral port, so this cannot collide with a dev server on 4113
    // running on the same machine.
    const handle = await startApiServer({ env: parseEnv({}), mastra: null, port: 0 })
    expect(handle.port).toBeGreaterThan(0)

    // Unauthenticated, because the point is the transport: a status the client can
    // read means bytes went in and out of the mounted app.
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/agent/threads`)
    expect(res.status).toBe(401)

    await handle.close()

    // If close() only pretended, this second bind would fail with EADDRINUSE.
    const again = await startApiServer({ env: parseEnv({}), mastra: null, port: handle.port })
    expect(again.port).toBe(handle.port)
    await again.close()
  })

  it('rejects rather than crashing the process when the port is taken', async () => {
    const first = await startApiServer({ env: parseEnv({}), mastra: null, port: 0 })
    // Same port, twice: `src/mastra/boot.ts` treats this as a logged degradation, so
    // the promise has to reject instead of letting an unhandled 'error' event throw.
    await expect(
      startApiServer({ env: parseEnv({}), mastra: null, port: first.port }),
    ).rejects.toThrow(/EADDRINUSE|address already in use/i)

    await first.close()
  })
})
