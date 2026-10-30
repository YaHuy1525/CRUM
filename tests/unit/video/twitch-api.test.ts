// tests/unit/video/twitch-api.test.ts
// Unit coverage for the thin HTTP client in src/video/twitch-api.ts.
// Every network call is exercised through an injected fake `fetch`, so these
// tests assert on the URL shape and headers the client produces — including
// the mandatory `Client-Id` header Twitch Helix requires on EVERY request —
// never on real Twitch endpoints.
import { describe, it, expect, vi } from 'vitest'
import {
  getFollowersTotal,
  getStream,
  refreshTwitchAccessToken,
  TwitchApiError,
} from '../../../src/video/twitch-api'
import type { TwitchApiConfig } from '../../../src/video/twitch-api'

const HELIX_BASE_URL = 'https://api.twitch.tv/helix'
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'

// ---------------------------------------------------------------------------
// Fake transport helpers
// ---------------------------------------------------------------------------

interface StubResponse {
  status: number
  /** Object → JSON.stringify; string → verbatim body (lets us feed non-JSON). */
  body: unknown
}

function stubResponse(stub: StubResponse): Response {
  const text = typeof stub.body === 'string' ? stub.body : JSON.stringify(stub.body)
  return {
    ok: stub.status >= 200 && stub.status < 300,
    status: stub.status,
    // Non-async on purpose: `Response#text()` returns a Promise, but the body
    // is already in memory, so there is nothing to await.
    text: () => text,
  } as unknown as Response
}

/**
 * Build a `TwitchApiConfig` whose fetch answers with the queued responses,
 * in order, while recording every call for assertions.
 */
function configWithFetch(...responses: StubResponse[]) {
  const queue = [...responses]
  // The `_`-prefixed parameters stay in the signature because they define the
  // recorded-call tuple the helpers below read back; the body is a plain
  // `Promise.resolve`, so an `async` wrapper would have nothing to await.
  const fetchFn = vi.fn((_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const next = queue.shift()
    if (!next) throw new Error('fake fetch: response queue exhausted')
    return Promise.resolve(stubResponse(next))
  })
  const config: TwitchApiConfig = { fetch: fetchFn }
  return { config, fetchFn }
}

/** The recorded fetch mock, with its declared call tuple preserved. */
type RecordedFetch = ReturnType<typeof configWithFetch>['fetchFn']

/**
 * The requested URL as text. The client always passes a `string` href; URL and
 * Request are resolved by field instead of `String(input)`, which would turn a
 * Request into `[object Object]`.
 */
function requestUrlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function urlAt(fetchFn: RecordedFetch, index = 0): URL {
  return new URL(requestUrlOf(fetchFn.mock.calls[index]![0]))
}

function urlTextAt(fetchFn: RecordedFetch, index = 0): string {
  return requestUrlOf(fetchFn.mock.calls[index]![0])
}

function initAt(fetchFn: RecordedFetch, index = 0): RequestInit {
  return fetchFn.mock.calls[index]![1] ?? {}
}

/**
 * The client serializes every request body to a string
 * (`URLSearchParams#toString()`), so the recorded body is narrowed to that
 * instead of stringified through `String(BodyInit)`.
 */
function bodyAt(fetchFn: RecordedFetch, index = 0): string {
  const body = initAt(fetchFn, index).body
  if (typeof body !== 'string') {
    throw new Error(`fake fetch: expected a string request body, got ${typeof body}`)
  }
  return body
}

function headersAt(fetchFn: RecordedFetch, index = 0): Record<string, string> {
  return initAt(fetchFn, index).headers as Record<string, string>
}

// ---------------------------------------------------------------------------
// Error capture helper
// ---------------------------------------------------------------------------

async function captureError(promise: Promise<unknown>): Promise<TwitchApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(TwitchApiError)
  return err as TwitchApiError
}

// ---------------------------------------------------------------------------
// getFollowersTotal
// ---------------------------------------------------------------------------

describe('getFollowersTotal', () => {
  it('GETs /channels/followers?broadcaster_id=… with BOTH the Bearer token and Client-Id headers', async () => {
    const { config, fetchFn } = configWithFetch({ status: 200, body: { total: 4200, pagination: {} } })

    const total = await getFollowersTotal('141991764', 'token-abc', 'my-client-id', config)

    const url = urlAt(fetchFn)
    expect(`${url.origin}${url.pathname}`).toBe(`${HELIX_BASE_URL}/channels/followers`)
    expect(url.searchParams.get('broadcaster_id')).toBe('141991764')
    expect(initAt(fetchFn).method).toBe('GET')
    const headers = headersAt(fetchFn)
    expect(headers.Authorization).toBe('Bearer token-abc')
    expect(headers['Client-Id']).toBe('my-client-id')
    expect(headers.Accept).toBe('application/json')
    expect(total).toBe(4200)
  })

  it('reports 0 when a 200 response omits total (no fabricated numbers)', async () => {
    const { config } = configWithFetch({ status: 200, body: { pagination: {} } })

    await expect(getFollowersTotal('141991764', 'token-abc', 'cid', config)).resolves.toBe(0)
  })

  it('tolerates a completely empty body', async () => {
    const { config } = configWithFetch({ status: 200, body: {} })

    await expect(getFollowersTotal('1', 'token-abc', 'cid', config)).resolves.toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getStream
// ---------------------------------------------------------------------------

describe('getStream', () => {
  it('GETs /streams?user_id=… and surfaces the live stream with its viewer_count', async () => {
    const { config, fetchFn } = configWithFetch({
      status: 200,
      body: {
        data: [
          {
            id: '4242',
            user_id: '141991764',
            user_name: 'cod3r',
            game_name: 'Just Chatting',
            title: 'building CRUM live',
            viewer_count: 137,
          },
        ],
        pagination: {},
      },
    })

    const stream = await getStream('141991764', 'token-abc', 'my-client-id', config)

    const url = urlAt(fetchFn)
    expect(`${url.origin}${url.pathname}`).toBe(`${HELIX_BASE_URL}/streams`)
    expect(url.searchParams.get('user_id')).toBe('141991764')
    const headers = headersAt(fetchFn)
    expect(headers.Authorization).toBe('Bearer token-abc')
    expect(headers['Client-Id']).toBe('my-client-id')

    expect(stream).toEqual({
      id: '4242',
      userId: '141991764',
      userName: 'cod3r',
      gameName: 'Just Chatting',
      title: 'building CRUM live',
      viewerCount: 137,
    })
  })

  it('returns null when the channel is offline (Helix answers data: [])', async () => {
    const { config } = configWithFetch({ status: 200, body: { data: [], pagination: {} } })

    await expect(getStream('141991764', 'token-abc', 'cid', config)).resolves.toBeNull()
  })

  it('coerces a missing viewer_count to 0 rather than guessing', async () => {
    const { config } = configWithFetch({
      status: 200,
      body: { data: [{ id: '1', user_id: '42', title: 't' }] },
    })

    const stream = await getStream('42', 'token-abc', 'cid', config)
    expect(stream?.viewerCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Error mapping (Helix envelope { error, status, message })
// ---------------------------------------------------------------------------

function helixError(status: number, error: string, message: string): StubResponse {
  return { status, body: { error, status, message } }
}

describe('Helix error handling', () => {
  it('maps a 401 Unauthorized to kind=auth with the reason and message preserved', async () => {
    const { config } = configWithFetch(helixError(401, 'Unauthorized', 'Invalid OAuth token'))

    const err = await captureError(getFollowersTotal('1', 'bad-token', 'cid', config))
    expect(err.status).toBe(401)
    expect(err.kind).toBe('auth')
    expect(err.reason).toBe('Unauthorized')
    expect(err.message).toContain('Invalid OAuth token')
    expect(err.message).toContain('(HTTP 401)')
    expect(err.name).toBe('TwitchApiError')
  })

  it('maps a 404 Not Found to kind=notFound', async () => {
    const { config } = configWithFetch(helixError(404, 'Not Found', 'User not found'))

    const err = await captureError(getStream('999', 'token-abc', 'cid', config))
    expect(err.status).toBe(404)
    expect(err.kind).toBe('notFound')
    expect(err.reason).toBe('Not Found')
  })

  it('maps a 429 Too Many Requests to kind=rateLimit', async () => {
    const { config } = configWithFetch(helixError(429, 'Too Many Requests', 'Slow down'))

    const err = await captureError(getFollowersTotal('1', 'token-abc', 'cid', config))
    expect(err.status).toBe(429)
    expect(err.kind).toBe('rateLimit')
  })

  it('classifies a 403 Forbidden as kind=auth (missing-scope style denial)', async () => {
    const { config } = configWithFetch(helixError(403, 'Forbidden', 'Missing scope'))

    const err = await captureError(getFollowersTotal('1', 'token-abc', 'cid', config))
    expect(err.status).toBe(403)
    expect(err.kind).toBe('auth')
  })

  it('falls back to kind=http and keeps the status for 5xx failures', async () => {
    const { config } = configWithFetch(helixError(500, 'Internal Server Error', 'Something broke'))

    const err = await captureError(getFollowersTotal('1', 'token-abc', 'cid', config))
    expect(err.status).toBe(500)
    expect(err.kind).toBe('http')
    expect(err.reason).toBe('Internal Server Error')
  })

  it('surfaces non-JSON error bodies as a TwitchApiError, not a parse crash', async () => {
    const { config } = configWithFetch({
      status: 502,
      body: '<html><head><title>Bad Gateway</title></head><body>nginx</body></html>',
    })

    const err = await captureError(getFollowersTotal('1', 'token-abc', 'cid', config))
    expect(err.status).toBe(502)
    expect(err.kind).toBe('http')
    expect(err.message).toContain('Bad Gateway')
    expect(err.message).toContain('(HTTP 502)')
  })

  it('wraps a transport-level fetch rejection in a TwitchApiError with status 0', async () => {
    const fetchFn = vi.fn((): Promise<Response> => Promise.reject(new Error('socket hang up')))
    const config: TwitchApiConfig = { fetch: fetchFn }

    const err = await captureError(getFollowersTotal('1', 'token-abc', 'cid', config))
    expect(err.status).toBe(0)
    expect(err.kind).toBe('http')
    expect(err.message).toContain('socket hang up')
  })
})

// ---------------------------------------------------------------------------
// refreshTwitchAccessToken (id.twitch.tv — different host, no Client-Id header)
// ---------------------------------------------------------------------------

describe('refreshTwitchAccessToken', () => {
  it('POSTs url-encoded refresh params and returns the rotated access AND refresh tokens', async () => {
    const { config, fetchFn } = configWithFetch({
      status: 200,
      body: {
        access_token: 'new-access-token',
        expires_in: 14400,
        refresh_token: 'new-rotated-refresh',
        scope: 'channel:read:subscriptions user:read:email',
        token_type: 'bearer',
      },
    })

    const result = await refreshTwitchAccessToken('refresh-me', 'my-client-id', 'my-client-secret', config)

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(urlTextAt(fetchFn)).toBe(TOKEN_URL)
    const init = initAt(fetchFn)
    expect(init.method).toBe('POST')
    expect(headersAt(fetchFn)['Content-Type']).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(bodyAt(fetchFn))
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('client_id')).toBe('my-client-id')
    expect(form.get('client_secret')).toBe('my-client-secret')
    expect(form.get('refresh_token')).toBe('refresh-me')

    // Twitch DOES rotate the refresh token — it must come back to the caller.
    expect(result).toEqual({
      accessToken: 'new-access-token',
      expiresIn: 14400,
      refreshToken: 'new-rotated-refresh',
    })
  })

  it('omits refreshToken from the result when the response does not rotate one', async () => {
    const { config } = configWithFetch({ status: 200, body: { access_token: 'tok', expires_in: 3600 } })

    const result = await refreshTwitchAccessToken('r', 'c', 's', config)
    expect(result).toEqual({ accessToken: 'tok', expiresIn: 3600 })
    expect(result.refreshToken).toBeUndefined()
  })

  it('defaults expiresIn to 0 when the response omits expires_in', async () => {
    const { config } = configWithFetch({ status: 200, body: { access_token: 'tok' } })

    await expect(refreshTwitchAccessToken('r', 'c', 's', config)).resolves.toEqual({
      accessToken: 'tok',
      expiresIn: 0,
    })
  })

  it('classifies a 400 invalid-grant style token failure as kind=auth', async () => {
    // id.twitch.tv answers token failures with its own { error, status, message }
    // envelope; 4xx there is always an auth-class rejection regardless of body.
    const { config } = configWithFetch({
      status: 400,
      body: { error: 'Invalid request', status: 400, message: 'invalid refresh token' },
    })

    const err = await captureError(refreshTwitchAccessToken('r', 'c', 's', config))
    expect(err.status).toBe(400)
    expect(err.kind).toBe('auth')
    expect(err.reason).toBe('Invalid request')
    expect(err.message).toContain('invalid refresh token')
  })

  it('classifies a 401 token-endpoint failure as kind=auth', async () => {
    const { config } = configWithFetch(helixError(401, 'Unauthorized', 'Invalid client credentials'))

    const err = await captureError(refreshTwitchAccessToken('r', 'c', 's', config))
    expect(err.status).toBe(401)
    expect(err.kind).toBe('auth')
  })

  it('classifies an error field inside a 200 body as kind=auth', async () => {
    const { config } = configWithFetch({
      status: 200,
      body: { error: 'Unsupported Grant Type', message: 'grant_type must be refresh_token' },
    })

    const err = await captureError(refreshTwitchAccessToken('r', 'c', 's', config))
    expect(err.kind).toBe('auth')
    expect(err.message).toContain('grant_type must be refresh_token')
  })

  it('throws kind=auth when the successful response carries no access_token', async () => {
    const { config } = configWithFetch({ status: 200, body: { expires_in: 3600 } })

    const err = await captureError(refreshTwitchAccessToken('r', 'c', 's', config))
    expect(err.kind).toBe('auth')
    expect(err.message).toContain('no access_token')
  })

  it('wraps a transport-level fetch rejection in a TwitchApiError with status 0', async () => {
    const fetchFn = vi.fn((): Promise<Response> => Promise.reject(new Error('connection reset')))
    const config: TwitchApiConfig = { fetch: fetchFn }

    const err = await captureError(refreshTwitchAccessToken('r', 'c', 's', config))
    expect(err.status).toBe(0)
    expect(err.kind).toBe('http')
    expect(err.message).toContain('connection reset')
  })
})
