// tests/api/gmail.test.ts
//
// The two OAuth routes are the trust boundary of the connector: they decide
// whose mailbox a code is attributed to. These tests pin the fail-closed
// behaviour (503 unconfigured / 400 bad identity / 400 tampered state) without
// opening a socket — fetch is mocked, and the pg singleton is mocked so
// saveConnection never reaches a database.
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { CrumEnv } from '../../src/config/env'
import { createState } from '../../src/gmail/client'
import { signState } from '../../src/gmail/crypto'

// vi.mock factories are hoisted above these imports, so the captured SQL needs
// vi.hoisted to exist by the time the factory runs.
const dbCalls = vi.hoisted(() => ({ calls: [] as { sql: string; params: unknown[] }[] }))

vi.mock('../../src/db/client', () => ({
  getDbClient: () => ({
    query: async (sql: string, params?: unknown[]) => {
      dbCalls.calls.push({ sql, params: params ?? [] })
      return { rows: [] }
    },
  }),
}))

const SECRET = 'r'.repeat(40)
const TENANT = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'

type MockCtx = {
  req: { query: (key: string) => string | undefined }
  json: (body: unknown, status?: number) => { kind: 'json'; status?: number; body: unknown }
  redirect: (url: string) => { kind: 'redirect'; url: string }
  html: (body: string, status?: number) => { kind: 'html'; status?: number; body: string }
}

function ctxFor(queries: Record<string, string>): MockCtx {
  return {
    req: { query: (key) => queries[key] },
    json: (body, status) => ({ kind: 'json', status, body }),
    redirect: (url) => ({ kind: 'redirect', url }),
    html: (body, status) => ({ kind: 'html', status, body }),
  }
}

function buildEnv(vars: Partial<Pick<CrumEnv, 'GMAIL_OAUTH_CLIENT_ID' | 'GMAIL_OAUTH_CLIENT_SECRET' | 'APPROVAL_HMAC_SECRET'>> = {}): CrumEnv {
  return {
    GMAIL_OAUTH_CLIENT_ID: 'cid.apps.googleusercontent.com',
    GMAIL_OAUTH_CLIENT_SECRET: 'csecret',
    APPROVAL_HMAC_SECRET: SECRET,
    ...vars,
  } as unknown as CrumEnv
}

// registerApiRoute returns a route whose handler we can call directly with a
// Hono-shaped context; the shape is asserted against the installed core in
// tests/entry (server config), here we only exercise the handler logic.
type RouteLike = { path?: string; handler: (c: unknown) => Promise<unknown> }
function handlerOf(route: unknown): (c: MockCtx) => Promise<unknown> {
  const resolved = route as RouteLike | { value?: RouteLike } | Promise<RouteLike>
  const direct = (resolved as RouteLike).handler
  if (direct) return direct as (c: MockCtx) => Promise<unknown>
  throw new Error('route object has no handler — check registerApiRoute shape')
}

async function connectHandler(env: CrumEnv) {
  const { createGmailConnectRoute } = await import('../../src/api/gmail')
  return handlerOf(createGmailConnectRoute(env))
}

async function callbackHandler(env: CrumEnv) {
  const { createGmailCallbackRoute } = await import('../../src/api/gmail')
  return handlerOf(createGmailCallbackRoute(env))
}

function mockFetchByHost(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal(
    'fetch',
    async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const result = (handler(url, init) ?? {}) as { body?: unknown; status?: number }
      const status = result.status ?? 200
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => result.body,
        text: async () => JSON.stringify(result.body ?? {}),
      }
    },
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  dbCalls.calls.length = 0
})

// @mastra/server reserves its built-in apiPrefix ('/api' by default) and
// validateCustomRoutePaths (server-adapter/index.js:1066) THROWS during server
// startup for any custom route whose path begins with it. A '/api/gmail/*'
// path therefore boots no server at all, which no handler-level test can catch.
// This asserts the predicate the framework itself applies, against the real
// route objects.
describe('route registration', () => {
  it('keeps both Gmail routes clear of the reserved /api prefix', async () => {
    const env = buildEnv()
    const { createGmailConnectRoute, createGmailCallbackRoute } = await import('../../src/api/gmail')
    const routes = [
      createGmailConnectRoute(env) as unknown as RouteLike,
      createGmailCallbackRoute(env) as unknown as RouteLike,
    ]
    for (const route of routes) {
      expect(route.path).toBeDefined()
      expect(route.path?.startsWith('/api/')).toBe(false)
      expect(route.path).not.toBe('/api')
    }
    expect(routes.map((r) => r.path)).toEqual(['/gmail/connect', '/gmail/callback'])
  })
})

describe('GET /gmail/connect', () => {
  it('503s when the connector is not configured — no flow can start', async () => {
    const handler = await connectHandler(buildEnv({ GMAIL_OAUTH_CLIENT_ID: undefined }))
    const res = (await handler(ctxFor({ tenantId: TENANT, userId: USER }))) as { kind: string; status?: number }
    expect(res.kind).toBe('json')
    expect(res.status).toBe(503)
  })

  it('400s unless both identity params are UUIDs (state must be attributable)', async () => {
    const handler = await connectHandler(buildEnv())
    const res = (await handler(ctxFor({ tenantId: 'not-a-uuid', userId: USER }))) as { kind: string; status?: number }
    expect(res.kind).toBe('json')
    expect(res.status).toBe(400)
  })

  it('302s to Google consent with a verifiable state', async () => {
    vi.stubEnv('APPROVAL_HMAC_SECRET', SECRET)
    const handler = await connectHandler(buildEnv())
    const res = (await handler(ctxFor({ tenantId: TENANT, userId: USER }))) as { kind: string; url: string }
    expect(res.kind).toBe('redirect')
    const url = new URL(res.url)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('access_type')).toBe('offline')
    const state = url.searchParams.get('state') as string
    expect(createState(TENANT, USER, SECRET)).not.toBe(state) // nonce/iv differ per call
    const { readState } = await import('../../src/gmail/client')
    expect(readState(state, SECRET)).toMatchObject({ tenantId: TENANT, userId: USER })
  })
})

describe('GET /gmail/callback', () => {
  it('400s when Google reports an error (user clicked Cancel)', async () => {
    const handler = await callbackHandler(buildEnv())
    const res = (await handler(
      ctxFor({ error: 'access_denied', state: createState(TENANT, USER, SECRET) }),
    )) as { kind: string; status?: number; body: string }
    expect(res.kind).toBe('html')
    expect(res.status).toBe(400)
    expect(res.body).toContain('did not grant access')
    expect(dbCalls.calls).toHaveLength(0)
  })

  it('400s on a tampered state and stores nothing', async () => {
    const handler = await callbackHandler(buildEnv())
    const forged = `${Buffer.from(JSON.stringify({ tenantId: TENANT, userId: USER, exp: Date.now() + 60_000, nonce: 'x' })).toString('base64url').split('.')[0]}.shortmac`
    const res = (await handler(ctxFor({ code: 'gc', state: forged }))) as { kind: string; status?: number; body: string }
    expect(res.kind).toBe('html')
    expect(res.status).toBe(400)
    expect(res.body).toContain('expired or was tampered with')
    expect(dbCalls.calls).toHaveLength(0)
  })

  it('400s on an expired state', async () => {
    const handler = await callbackHandler(buildEnv())
    const expired = signState({ tenantId: TENANT, userId: USER, exp: Date.now() - 1, nonce: 'zz' }, SECRET)
    const res = (await handler(ctxFor({ code: 'gc', state: expired }))) as { kind: string; status?: number }
    expect(res.status).toBe(400)
    expect(dbCalls.calls).toHaveLength(0)
  })

  it('exchanges, stores the encrypted refresh token, and reports the mailbox', async () => {
    vi.stubEnv('APPROVAL_HMAC_SECRET', SECRET)
    mockFetchByHost((url) =>
      url.includes('oauth2.googleapis.com/token')
        ? { body: { access_token: 'ya29.a', refresh_token: '1//r', expires_in: 3600 } }
        : url.includes('gmail.googleapis.com')
          ? { body: { emailAddress: 'me@gmail.example' } }
          : { body: {} },
    )
    const handler = await callbackHandler(buildEnv())
    const res = (await handler(ctxFor({ code: 'google-code', state: createState(TENANT, USER, SECRET) }))) as {
      kind: string
      status?: number
      body: string
    }
    expect(res.kind).toBe('html')
    expect(res.status).toBeUndefined() // 200
    expect(res.body).toContain('Connected me@gmail.example')

    expect(dbCalls.calls).toHaveLength(1)
    const call = dbCalls.calls[0] as { sql: string; params: unknown[] }
    expect(call.sql).toContain('INSERT INTO gmail_connections')
    expect(call.params[0]).toBe(TENANT)
    expect(call.params[1]).toBe(USER)
    expect(call.params[2]).toBe('me@gmail.example')
    const storedToken = call.params[3] as string
    expect(storedToken).not.toBe('1//r')
    expect(storedToken.startsWith('v1.')).toBe(true)
  })

  it('500s with a readable message when the token exchange fails', async () => {
    vi.stubEnv('APPROVAL_HMAC_SECRET', SECRET)
    mockFetchByHost(() => ({ body: { access_token: 'ya29.a', expires_in: 3600 } })) // no refresh token
    const handler = await callbackHandler(buildEnv())
    const res = (await handler(ctxFor({ code: 'google-code', state: createState(TENANT, USER, SECRET) }))) as {
      kind: string
      status?: number
      body: string
    }
    expect(res.status).toBe(500)
    expect(res.body).toContain('Connecting failed')
    expect(dbCalls.calls).toHaveLength(0)
  })
})
