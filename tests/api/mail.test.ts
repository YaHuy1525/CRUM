// tests/api/mail.test.ts
//
// The mailbox data plane. Two seams are pinned here:
//
// 1. Identity is verified before anything Gmail-facing happens, and a missing
//    connection is a 404 `not_connected` the console can render — never a 500.
// 2. The Gmail API is the only outbound caller, so fetch is mocked per host:
//    token refresh hits oauth2.googleapis.com, searches and drafts hit
//    gmail.googleapis.com. The pg singleton is mocked, so loadConnection never
//    opens a socket, and the stored refresh token is genuinely encrypted with
//    the same helper the callback route uses.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

const db = vi.hoisted((): { rows: Record<string, unknown[]> } => ({ rows: {} }))

vi.mock('../../src/db/client', () => ({
  getDbClient: () => ({
    query: (sql: string): Promise<{ rows: unknown[] }> => {
      const needle = sql.includes('FROM gmail_connections') ? 'connections' : 'other'
      return Promise.resolve({ rows: db.rows[needle] ?? [] })
    },
    connect: () => Promise.reject(new Error('route tests must not open a transaction connection')),
  }),
  closeDbClient: async () => {},
}))

import { createMailRouter } from '../../src/api/mail'
import { clearAccessTokenCache } from '../../src/gmail/client'
import { encryptRefreshToken } from '../../src/gmail/crypto'
import { parseEnv } from '../../src/config/env'

const SECRET = 'r'.repeat(40)
const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const USER = '660e8400-e29b-41d4-a716-446655440009'
// Gmail thread ids are long decimal strings, as returned by the real API.
const THREAD_ID = '1913726543210987654'
const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

const env = () =>
  parseEnv({
    GMAIL_OAUTH_CLIENT_ID: 'cid.apps.googleusercontent.com',
    GMAIL_OAUTH_CLIENT_SECRET: 'csecret',
    APPROVAL_HMAC_SECRET: SECRET,
  })

function router(): Hono {
  return createMailRouter({ env: env() })
}

function connectedRow(): void {
  db.rows['connections'] = [
    {
      id: '11111111-2222-4333-8444-555555555555',
      tenant_id: TENANT,
      user_id: USER,
      gmail_email: 'me@gmail.example',
      refresh_token_enc: encryptRefreshToken('1//refresh', SECRET),
      scopes: 'gmail.readonly gmail.compose',
    },
  ]
}

interface RecordedCall {
  url: string
  init?: RequestInit
}

function mockGmailFetch(recorded: RecordedCall[], threadPayload?: unknown): void {
  vi.stubGlobal(
    'fetch',
    (input: unknown, init?: RequestInit) => {
      const url = String(input)
      recorded.push({ url, init })
      const body = url.includes('oauth2.googleapis.com/token')
        ? { access_token: 'ya29.a', expires_in: 3600 }
        : url.includes('gmail.googleapis.com/gmail/v1/users/me/threads?') || url.includes('/threads?')
          ? { threads: [{ id: THREAD_ID }] }
          : url.includes(`/threads/${THREAD_ID}`)
            ? (threadPayload ?? {
                id: THREAD_ID,
                snippet: 'Hello',
                messages: [
                  {
                    payload: {
                      headers: [
                        { name: 'From', value: 'Ariel <a@x.com>' },
                        { name: 'Subject', value: 'Invoice' },
                        { name: 'Date', value: 'Mon, 26 Oct 2026 09:00:00 +0000' },
                      ],
                    },
                  },
                ],
              })
            : url.includes('/drafts')
              ? { id: 'draft-9' }
              : {}
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      })
    },
  )
}

async function jsonOf<T = Record<string, unknown>>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}

beforeEach(() => {
  db.rows['connections'] = []
  vi.stubEnv('APPROVAL_HMAC_SECRET', SECRET)
  // getAccessToken caches by tenant:user — the same ids every test uses, so a
  // token one test mocked would otherwise serve the next test for real.
  clearAccessTokenCache(TENANT, USER)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('identity and configuration guards', () => {
  it('401s every route without identity headers, before any Gmail call', async () => {
    const res = await router().request('/api/mail/status')
    expect(res.status).toBe(401)
    expect(await jsonOf(res)).toMatchObject({ error: 'unauthorized' })
  })

  it('reports status honestly when the connector is not configured', async () => {
    const bare = createMailRouter({ env: parseEnv({ APPROVAL_HMAC_SECRET: SECRET }) })
    const res = await bare.request('/api/mail/status', { headers: AUTH })
    expect(res.status).toBe(200)
    expect(await jsonOf(res)).toMatchObject({ configured: false, connected: false })
  })

  it('503s connect-url when the state secret is missing', async () => {
    const noSecret = createMailRouter({ env: parseEnv({ GMAIL_OAUTH_CLIENT_ID: 'cid', GMAIL_OAUTH_CLIENT_SECRET: 'cs' }) })
    const res = await noSecret.request('/api/mail/connect-url', { headers: AUTH })
    expect(res.status).toBe(503)
  })
})

describe('GET /api/mail/status', () => {
  it('says not_connected when nobody consented', async () => {
    const res = await router().request('/api/mail/status', { headers: AUTH })
    expect(res.status).toBe(200)
    expect(await jsonOf(res)).toMatchObject({ configured: true, connected: false })
  })

  it('returns the mailbox address when connected', async () => {
    connectedRow()
    const res = await router().request('/api/mail/status', { headers: AUTH })
    expect(res.status).toBe(200)
    expect(await jsonOf(res)).toMatchObject({ connected: true, email: 'me@gmail.example' })
  })
})

describe('GET /api/mail/connect-url', () => {
  it('builds a Google consent URL with a state that resolves back to the caller', async () => {
    const res = await router().request('/api/mail/connect-url', { headers: AUTH })
    expect(res.status).toBe(200)
    const body = await jsonOf<{ url: string; redirectUri: string }>(res)
    const url = new URL(body.url)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(body.redirectUri).toBe('http://localhost:4111/gmail/callback')

    const { readState } = await import('../../src/gmail/client')
    expect(readState(url.searchParams.get('state') as string, SECRET)).toMatchObject({ tenantId: TENANT, userId: USER })
  })
})

describe('GET /api/mail/threads', () => {
  it('404s not_connected when no mailbox is linked', async () => {
    const res = await router().request('/api/mail/threads?q=in:inbox', { headers: AUTH })
    expect(res.status).toBe(404)
    expect(await jsonOf(res)).toMatchObject({ error: 'not_connected' })
  })

  it('400s a missing query', async () => {
    connectedRow()
    const res = await router().request('/api/mail/threads', { headers: AUTH })
    expect(res.status).toBe(400)
  })

  it('returns summaries with subject, senders, date from the real Gmail shape', async () => {
    connectedRow()
    const recorded: RecordedCall[] = []
    mockGmailFetch(recorded)
    const res = await router().request('/api/mail/threads?q=subject:invoice', { headers: AUTH })
    expect(res.status).toBe(200)
    const body = await jsonOf<{ threads: { id: string; subject: string; senders: string[]; date: string }[] }>(res)
    expect(body.threads).toHaveLength(1)
    expect(body.threads[0]).toMatchObject({ id: THREAD_ID, subject: 'Invoice', senders: ['Ariel <a@x.com>'] })
    expect(recorded.some((r) => r.url.includes('q=subject%3Ainvoice'))).toBe(true)
    // The Bearer token used for the search came from the mocked refresh flow.
    expect(recorded.some((r) => (r.init?.headers as Record<string, string>)?.Authorization === 'Bearer ya29.a')).toBe(true)
  })

  it('surfaces a Gmail API failure as 502, not as an empty list', async () => {
    connectedRow()
    vi.stubGlobal('fetch', (input: unknown) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ access_token: 'ya29.a', expires_in: 3600 }), text: () => Promise.resolve('') })
      }
      return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}), text: () => Promise.resolve('Insufficient Authentication Scopes') })
    })
    const res = await router().request('/api/mail/threads?q=in:inbox', { headers: AUTH })
    expect(res.status).toBe(400)
    const body = await jsonOf<{ error: string; detail: string }>(res)
    expect(body.error).toBe('gmail_api_failed')
    expect(body.detail).toContain('Insufficient Authentication Scopes')
  })

  it('503s reconnect_required when the stored refresh token is dead', async () => {
    db.rows['connections'] = [
      {
        id: '11111111-2222-4333-8444-555555555555',
        tenant_id: TENANT,
        user_id: USER,
        gmail_email: 'me@gmail.example',
        refresh_token_enc: 'not-a-valid-ciphertext',
        scopes: 'gmail.readonly gmail.compose',
      },
    ]
    const res = await router().request('/api/mail/threads?q=in:inbox', { headers: AUTH })
    expect(res.status).toBe(503)
    const body = await jsonOf<{ error: string; detail: string }>(res)
    expect(body.error).toBe('reconnect_required')
    expect(body.detail).toContain('corrupt')
  })
})

describe('GET /api/mail/threads/:id', () => {
  it('never reaches the mailbox for an id that cannot be a Gmail thread id', async () => {
    // Hono collapses `..` segments at dispatch, so the traversal attempt lands
    // on no route at all; a syntactically-invalid id that does reach the handler
    // is refused with 400 before any token is loaded.
    const traversal = await router().request('/api/mail/threads/../../etc', { headers: AUTH })
    expect([400, 404]).toContain(traversal.status)
    const badId = await router().request('/api/mail/threads/not-a-thread', { headers: AUTH })
    expect(badId.status).toBe(400)
    expect(await jsonOf(badId)).toMatchObject({ error: 'invalid_thread_id' })
  })

  it('fetches a single thread by its id', async () => {
    connectedRow()
    const recorded: RecordedCall[] = []
    mockGmailFetch(recorded)
    const res = await router().request(`/api/mail/threads/${THREAD_ID}`, { headers: AUTH })
    expect(res.status).toBe(200)
    expect(await jsonOf(res)).toMatchObject({ id: THREAD_ID, subject: 'Invoice' })
    expect(recorded.some((r) => r.url.includes(`q=thread%3A${THREAD_ID}`))).toBe(true)
  })
})

describe('POST /api/mail/drafts', () => {
  it('400s a body without to/body', async () => {
    connectedRow()
    const res = await router().request('/api/mail/drafts', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'hi' }),
    })
    expect(res.status).toBe(400)
  })

  it('creates the draft and answers the draft id and link', async () => {
    connectedRow()
    const recorded: RecordedCall[] = []
    mockGmailFetch(recorded)
    const res = await router().request('/api/mail/drafts', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'a@x.com', subject: 'Follow-up', body: 'Thanks for the call.' }),
    })
    expect(res.status).toBe(200)
    const body = await jsonOf<{ draftId: string; url: string }>(res)
    expect(body.draftId).toBe('draft-9')
    expect(body.url).toContain('draft-9')
    const draftCall = recorded.find((r) => r.url.endsWith('/drafts'))
    expect(draftCall?.init?.method).toBe('POST')
  })
})
