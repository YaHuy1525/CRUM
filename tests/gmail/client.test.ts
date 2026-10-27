// tests/gmail/client.test.ts
//
// Unit coverage for the Gmail connector's OAuth and REST plumbing. No socket
// is opened and no DB is touched: fetch is mocked at the global boundary and
// queries go through an injected Queryable, per the client's own design note.
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  GMAIL_SCOPES,
  buildConsentUrl,
  createState,
  exchangeCodeForTokens,
  fetchProfileEmail,
  createGmailDraft,
  getAccessToken,
  clearAccessTokenCache,
  gmailOAuthConfigured,
  readState,
  saveConnection,
  loadConnection,
  searchThreadSummaries,
  GmailApiError,
} from '../../src/gmail/client'
import type { CrumEnv } from '../../src/config/env'

const SECRET = 'k'.repeat(40)

/** Minimal env for the pure functions — they only read the Gmail keys. */
function gmailEnv(overrides: Partial<Pick<CrumEnv, 'GMAIL_OAUTH_CLIENT_ID' | 'GMAIL_OAUTH_CLIENT_SECRET' | 'GMAIL_REDIRECT_URI'>> = {}): CrumEnv {
  return {
    GMAIL_OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GMAIL_OAUTH_CLIENT_SECRET: 'client-secret',
    GMAIL_REDIRECT_URI: undefined,
    ...overrides,
  } as unknown as CrumEnv
}

function mockFetch(fn: (url: string, init?: RequestInit) => unknown): typeof globalThis.fetch {
  const impl = vi.fn((input: unknown, init?: RequestInit) => {
    const url = String(input)
    const result = fn(url, init)
    const r = (result ?? {}) as { body?: unknown; status?: number }
    const body = 'body' in r ? r.body : r
    const status = r.status ?? 200
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    })
  }) as unknown as typeof globalThis.fetch
  vi.stubGlobal('fetch', impl)
  return impl
}

function jsonFetch(body: unknown, status = 200) {
  return mockFetch(() => ({ body, status }))
}

/**
 * Read a form body off a recorded fetch call. Narrowing by hand is stronger than
 * `String(init.body)`, which would quietly yield "[object Object]".
 */
function formBody(init: RequestInit): URLSearchParams {
  if (init.body instanceof URLSearchParams) return init.body
  if (typeof init.body === 'string') return new URLSearchParams(init.body)
  throw new Error(`unexpected request body shape: ${typeof init.body}`)
}

/** Read a JSON string body off a recorded fetch call. */
function jsonStringBody(init: RequestInit): string {
  if (typeof init.body !== 'string') {
    throw new Error(`unexpected request body shape: ${typeof init.body}`)
  }
  return init.body
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('consent URL', () => {
  it('returns null until both OAuth client keys are present', () => {
    expect(gmailOAuthConfigured(gmailEnv({ GMAIL_OAUTH_CLIENT_ID: undefined }))).toBeNull()
    expect(gmailOAuthConfigured(gmailEnv({ GMAIL_OAUTH_CLIENT_SECRET: undefined }))).toBeNull()
    expect(gmailOAuthConfigured(gmailEnv())).not.toBeNull()
  })

  it('falls back to the localhost callback URI when GMAIL_REDIRECT_URI is unset', () => {
    const creds = gmailOAuthConfigured(gmailEnv())
    expect(creds?.redirectUri).toBe('http://localhost:4111/gmail/callback')
    const custom = gmailOAuthConfigured(gmailEnv({ GMAIL_REDIRECT_URI: 'https://crm.example.com/cb' }))
    expect(custom?.redirectUri).toBe('https://crm.example.com/cb')
  })

  it('carries the parameters Google requires for a refresh token', () => {
    const url = new URL(buildConsentUrl({ clientId: 'cid', redirectUri: 'https://app/cb' }, 'state-xyz'))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    // access_type=offline is what makes Google mint a refresh token at all,
    // and prompt=consent makes a re-connect reliably mint a NEW one.
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('include_granted_scopes')).toBe('true')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app/cb')
    expect(url.searchParams.get('state')).toBe('state-xyz')
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([...GMAIL_SCOPES])
  })

  it('state round-trips through create → read', () => {
    const state = createState('tenant-1', 'user-1', SECRET)
    expect(readState(state, SECRET)).toMatchObject({ tenantId: 'tenant-1', userId: 'user-1' })
  })
})

describe('exchangeCodeForTokens', () => {
  const creds = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://app/cb' }

  it('posts an authorization_code grant and returns both tokens', async () => {
    const fetchMock = jsonFetch({ access_token: 'ya29.access', refresh_token: '1//refresh', expires_in: 3600 })
    const tokens = await exchangeCodeForTokens(creds, 'google-auth-code')
    expect(tokens).toEqual({ refreshToken: '1//refresh', accessToken: 'ya29.access' })
    const [url, init] = vi.mocked(fetchMock).mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('https://oauth2.googleapis.com/token')
    const form = formBody(init)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('google-auth-code')
    expect(form.get('client_id')).toBe('cid')
    expect(form.get('client_secret')).toBe('secret')
    expect(form.get('redirect_uri')).toBe('https://app/cb')
  })

  it('refuses to proceed when Google returns no refresh token', async () => {
    // consent without prompt=consent / a revoked approval can yield access-only;
    // storing nothing is the only safe reaction, or the connection is dead on reconnect.
    jsonFetch({ access_token: 'ya29.access', expires_in: 3600 })
    await expect(exchangeCodeForTokens(creds, 'code')).rejects.toThrow(GmailApiError)
  })

  it('surfaces Google error responses as GmailApiError', async () => {
    jsonFetch({ error: 'invalid_grant', error_description: 'Bad Request' }, 400)
    await expect(exchangeCodeForTokens(creds, 'code')).rejects.toThrow(/invalid_grant/)
  })
})

describe('getAccessToken', () => {
  const row = {
    id: 'c1',
    tenant_id: 'tenant-1',
    user_id: 'user-1',
    gmail_email: 'me@example.com',
    scopes: 'gmail.readonly gmail.compose',
    refresh_token_enc: '',
  }

  it('decrypts the stored token, refreshes, and caches the result', async () => {
    vi.stubEnv('APPROVAL_HMAC_SECRET', SECRET)
    const { encryptRefreshToken } = await import('../../src/gmail/crypto')
    const encRow = { ...row, refresh_token_enc: encryptRefreshToken('1//refresh', SECRET) }

    const fetchMock = jsonFetch({ access_token: 'ya29.fresh', expires_in: 3600 })
    clearAccessTokenCache('tenant-1', 'user-1')
    await expect(getAccessToken(encRow, 'cid', 'secret')).resolves.toBe('ya29.fresh')
    const [, init] = vi.mocked(fetchMock).mock.calls[0] as unknown as [string, RequestInit]
    const form = formBody(init)
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('1//refresh')

    // Second call must hit the process cache, not the token endpoint.
    await expect(getAccessToken(encRow, 'cid', 'secret')).resolves.toBe('ya29.fresh')
    expect(vi.mocked(fetchMock)).toHaveBeenCalledTimes(1)
    clearAccessTokenCache('tenant-1', 'user-1')
  })

  it('throws when the envelope secret is gone', async () => {
    vi.stubEnv('APPROVAL_HMAC_SECRET', undefined)
    clearAccessTokenCache('tenant-2', 'user-2')
    await expect(getAccessToken(encRow2(), 'cid', 'secret')).rejects.toThrow(GmailApiError)
  })
})

function encRow2() {
  return { ...rowShim, refresh_token_enc: 'v1.aaa.bbb.ccc' }
}
const rowShim = {
  id: 'c2',
  tenant_id: 'tenant-2',
  user_id: 'user-2',
  gmail_email: 'x@example.com',
  scopes: '',
}

describe('connection storage', () => {
  it('encrypts before storing and upserts per (tenant, user)', async () => {
    vi.stubEnv('APPROVAL_HMAC_SECRET', SECRET)
    const calls: { sql: string; params: unknown[] }[] = []
    const pool = {
      query: (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] })
        return Promise.resolve({ rows: [] })
      },
    }
    await saveConnection(
      { tenantId: 't', userId: 'u', gmailEmail: 'me@example.com', refreshToken: '1//refresh', scopes: 'gmail.readonly' },
      pool,
    )
    expect(calls).toHaveLength(1)
    const call = calls[0] as { sql: string; params: unknown[] }
    expect(call.sql).toContain('INSERT INTO gmail_connections')
    expect(call.sql).toContain('ON CONFLICT (tenant_id, user_id)')
    const stored = call.params[3] as string
    expect(stored).not.toBe('1//refresh')
    expect(stored.startsWith('v1.')).toBe(true)

    const { decryptRefreshToken } = await import('../../src/gmail/crypto')
    expect(decryptRefreshToken(stored, SECRET)).toBe('1//refresh')
  })

  it('refuses to store without the encryption secret', async () => {
    vi.stubEnv('APPROVAL_HMAC_SECRET', undefined)
    await expect(
      saveConnection(
        { tenantId: 't', userId: 'u', gmailEmail: 'me@example.com', refreshToken: 'r', scopes: 's' },
        { query: () => Promise.resolve({ rows: [] }) },
      ),
    ).rejects.toThrow(GmailApiError)
  })

  it('loadConnection returns the first row or null', async () => {
    const fakeRow = { ...rowShim, refresh_token_enc: 'v1.x.y.z' }
    const poolRow = { query: () => Promise.resolve({ rows: [fakeRow] }) }
    const poolEmpty = { query: () => Promise.resolve({ rows: [] }) }
    await expect(loadConnection('tenant-2', 'user-2', poolRow)).resolves.toEqual(fakeRow)
    await expect(loadConnection('tenant-2', 'user-2', poolEmpty)).resolves.toBeNull()
  })
})

describe('gmail REST surface', () => {
  it('fetchProfileEmail reads the address from /users/me/profile', async () => {
    const fetchMock = jsonFetch({ emailAddress: 'me@example.com' })
    await expect(fetchProfileEmail('ya29.token')).resolves.toBe('me@example.com')
    const [url] = vi.mocked(fetchMock).mock.calls[0] as unknown as [string]
    // The bare /users/me root 404s on real Google (HTML error page) — the
    // resource segment is load-bearing, verified on the live consent flow.
    expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile')
  })

  it('searchThreadSummaries lists, fetches metadata, and caps snippets', async () => {
    const longSnippet = 'p'.repeat(600)
    const fetchMock = mockFetch((url) => {
      if (url.includes('/threads?')) return { body: { threads: [{ id: 'thr-1' }] } }
      if (url.includes('/threads/thr-1')) {
        return {
          body: {
            id: 'thr-1',
            snippet: longSnippet,
            // The shape Gmail actually returns for format=metadata: headers
            // live under messages[].payload, not a `part`.
            messages: [{ payload: { headers: [{ name: 'From', value: 'Ariel <a@x.com>, B <b@x.com>' }, { name: 'Subject', value: 'Invoice' }, { name: 'Date', value: 'Mon, 26 Oct 2026 09:00:00 +0000' }] } }],
          },
        }
      }
      return { body: {} }
    })
    const threads = await searchThreadSummaries('ya29.token', 'subject:invoice', 5)
    expect(threads).toHaveLength(1)
    expect(threads[0]).toEqual({
      id: 'thr-1',
      subject: 'Invoice',
      snippet: 'p'.repeat(500),
      senders: ['Ariel <a@x.com>', 'B <b@x.com>'],
      date: 'Mon, 26 Oct 2026 09:00:00 +0000',
    })
    const [listUrl] = vi.mocked(fetchMock).mock.calls[0] as unknown as [string]
    expect(String(listUrl)).toContain('/threads?q=subject%3Ainvoice&maxResults=5')
  })

  it('wraps a non-2xx gmail response in GmailApiError with the status', async () => {
    jsonFetch({ message: 'quota exceeded' }, 429)
    await expect(fetchProfileEmail('bad-token')).rejects.toThrow(/HTTP 429/)
  })

  it('createGmailDraft posts a base64url RFC2822 message', async () => {
    const fetchMock = jsonFetch({ id: 'draft-1' })
    await expect(createGmailDraft('ya29.token', { to: 'a@x.com', subject: 'Hi', body: 'Hello there' })).resolves.toEqual({ id: 'draft-1' })
    const [url, init] = vi.mocked(fetchMock).mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts')
    expect(init.method).toBe('POST')
    const payload = JSON.parse(jsonStringBody(init)) as { message: { raw: string } }
    const raw = Buffer.from(payload.message.raw, 'base64url').toString('utf8')
    expect(raw).toContain('To: a@x.com')
    expect(raw).toContain('Subject: Hi')
    expect(raw).toContain('Hello there')
    const [, authInit] = vi.mocked(fetchMock).mock.calls[0] as unknown as [string, RequestInit]
    expect((authInit.headers as Record<string, string>).Authorization).toBe('Bearer ya29.token')
  })
})
