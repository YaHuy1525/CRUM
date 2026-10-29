// tests/unit/video/tiktok-api.test.ts
// Unit coverage for the thin HTTP client in src/video/tiktok-api.ts.
// Every network call is exercised through an injected fake `fetch`, so these
// tests assert on the URL shape, HTTP method, headers and encoded/JSON bodies
// the client produces — never on real TikTok endpoints.
import { describe, it, expect, vi } from 'vitest'
import {
  queryVideos,
  refreshTiktokAccessToken,
  TiktokApiError,
} from '../../../src/video/tiktok-api'
import type { VideoQueryParams, TiktokApiConfig } from '../../../src/video/tiktok-api'

const VIDEO_QUERY_URL = 'https://open.tiktokapis.com/v2/video/query/'
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/'
const FIELDS = 'video_id,title,stats.play_count,stats.digg_count,stats.comment_count,stats.share_count'

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
    text: async () => text,
  } as unknown as Response
}

/**
 * Build a `TiktokApiConfig` whose fetch answers with the queued responses, in
 * order, while recording every call for assertions.
 */
function configWithFetch(...responses: StubResponse[]) {
  const queue = [...responses]
  const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const next = queue.shift()
    if (!next) throw new Error('fake fetch: response queue exhausted')
    return stubResponse(next)
  })
  const config: TiktokApiConfig = { fetch: fetchFn as unknown as typeof fetch }
  return { config, fetchFn }
}

function urlAt(fetchFn: ReturnType<typeof vi.fn>, index = 0): URL {
  const call = fetchFn.mock.calls[index]
  return new URL(String(call![0]))
}

function initAt(fetchFn: ReturnType<typeof vi.fn>, index = 0): RequestInit {
  return fetchFn.mock.calls[index]![1] as RequestInit
}

function headersAt(fetchFn: ReturnType<typeof vi.fn>, index = 0): Record<string, string> {
  return initAt(fetchFn, index).headers as Record<string, string>
}

function jsonBodyAt(fetchFn: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  return JSON.parse(String(initAt(fetchFn, index).body)) as Record<string, unknown>
}

// A video-query page body shaped exactly like the Display API v2 response.
function videoPage(videos: unknown[], cursor: number, hasMore: boolean): unknown {
  return { data: { videos, cursor, has_more: hasMore } }
}

async function captureError(promise: Promise<unknown>): Promise<TiktokApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(TiktokApiError)
  return err as TiktokApiError
}

// ---------------------------------------------------------------------------
// queryVideos — request construction
// ---------------------------------------------------------------------------

describe('queryVideos – request construction', () => {
  const params: VideoQueryParams = { maxResults: 20 }

  it('POSTs the fields projection with a JSON filter body and Bearer token', async () => {
    const { config, fetchFn } = configWithFetch({ status: 200, body: videoPage([], 0, false) })

    await queryVideos('secret-token', params, config)

    const url = urlAt(fetchFn)
    expect(`${url.origin}${url.pathname}`).toBe(VIDEO_QUERY_URL)
    expect(url.searchParams.get('fields')).toBe(FIELDS)

    expect(initAt(fetchFn).method).toBe('POST')
    expect(headersAt(fetchFn).Authorization).toBe('Bearer secret-token')
    expect(headersAt(fetchFn)['Content-Type']).toBe('application/json')
    expect(headersAt(fetchFn).Accept).toBe('application/json')

    expect(jsonBodyAt(fetchFn)).toEqual({
      filters: { deleted_video: false },
      max_results: 20,
    })
  })

  it('defaults max_results to 20 when params omit it and omits after_cursor on page 1', async () => {
    const { config, fetchFn } = configWithFetch({ status: 200, body: videoPage([], 0, false) })

    await queryVideos('t', {}, config)

    const body = jsonBodyAt(fetchFn)
    expect(body.max_results).toBe(20)
    expect(body).not.toHaveProperty('after_cursor')
  })

  it('threads the pagination cursor into the body as after_cursor', async () => {
    const { config, fetchFn } = configWithFetch({ status: 200, body: videoPage([], 40, false) })

    await queryVideos('t', { cursor: 20, maxResults: 15 }, config)

    const body = jsonBodyAt(fetchFn)
    expect(body.after_cursor).toBe(20)
    expect(body.max_results).toBe(15)
  })

  it('does not send after_cursor when the cursor is 0 (page boundary)', async () => {
    const { config, fetchFn } = configWithFetch({ status: 200, body: videoPage([], 0, false) })

    await queryVideos('t', { cursor: 0 }, config)

    expect(jsonBodyAt(fetchFn)).not.toHaveProperty('after_cursor')
  })
})

// ---------------------------------------------------------------------------
// queryVideos — response parsing
// ---------------------------------------------------------------------------

describe('queryVideos – response parsing', () => {
  it('maps data.videos to stats objects and coerces string counters to numbers', async () => {
    const { config } = configWithFetch({
      status: 200,
      body: videoPage(
        [
          { id: 'v1', stats: { play_count: 1000, digg_count: 50, comment_count: '12', share_count: 3 } },
          // A missing stats block degrades to all-zero, not a crash.
          { id: 'v2' },
        ],
        20,
        true,
      ),
    })

    const page = await queryVideos('t', {}, config)

    expect(page.hasMore).toBe(true)
    expect(page.cursor).toBe(20)
    expect(page.videos).toEqual([
      { videoId: 'v1', views: 1000, likes: 50, comments: 12, shares: 3 },
      { videoId: 'v2', views: 0, likes: 0, comments: 0, shares: 0 },
    ])
    expect(typeof page.videos[0]!.views).toBe('number')
    expect(typeof page.videos[0]!.comments).toBe('number')
  })

  it('returns an empty page when the response omits data entirely', async () => {
    const { config } = configWithFetch({ status: 200, body: {} })

    await expect(queryVideos('t', {}, config)).resolves.toEqual({
      videos: [],
      cursor: 0,
      hasMore: false,
    })
  })
})

// ---------------------------------------------------------------------------
// queryVideos — error classification
// ---------------------------------------------------------------------------

describe('queryVideos – error handling', () => {
  it('classifies a 401 token error from the API host as kind=auth', async () => {
    const { config } = configWithFetch({
      status: 401,
      body: { error: { code: 'error_access_token_wrong', message: 'invalid access token' } },
    })

    const err = await captureError(queryVideos('t', {}, config))
    expect(err.status).toBe(401)
    expect(err.kind).toBe('auth')
    expect(err.reason).toBe('error_access_token_wrong')
    expect(err.message).toContain('invalid access token')
    expect(err.message).toContain('(HTTP 401)')
    expect(err.name).toBe('TiktokApiError')
  })

  it('classifies a 429 rate-limit response as kind=rateLimit', async () => {
    const { config } = configWithFetch({
      status: 429,
      body: { error: { code: 'rate_limit_exceeded', message: 'Too many requests' } },
    })

    const err = await captureError(queryVideos('t', {}, config))
    expect(err.status).toBe(429)
    expect(err.kind).toBe('rateLimit')
  })

  it('falls back to kind=http for an unrelated 5xx', async () => {
    const { config } = configWithFetch({
      status: 500,
      body: { error: { code: 'internal_error', message: 'server blew up' } },
    })

    const err = await captureError(queryVideos('t', {}, config))
    expect(err.status).toBe(500)
    expect(err.kind).toBe('http')
  })

  it('surfaces a non-JSON error body as a TiktokApiError, not a parse crash', async () => {
    const { config } = configWithFetch({
      status: 502,
      body: '<html><head><title>Bad Gateway</title></head><body>tengine</body></html>',
    })

    const err = await captureError(queryVideos('t', {}, config))
    expect(err.status).toBe(502)
    expect(err.kind).toBe('http')
    expect(err.message).toContain('Bad Gateway')
    expect(err.message).toContain('(HTTP 502)')
  })

  it('wraps a transport-level fetch rejection in a TiktokApiError with status 0', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('socket hang up')
    })
    const config: TiktokApiConfig = { fetch: fetchFn as unknown as typeof fetch }

    const err = await captureError(queryVideos('t', {}, config))
    expect(err.status).toBe(0)
    expect(err.kind).toBe('http')
    expect(err.message).toContain('socket hang up')
  })
})

// ---------------------------------------------------------------------------
// refreshTiktokAccessToken
// ---------------------------------------------------------------------------

describe('refreshTiktokAccessToken', () => {
  it('POSTs url-encoded client_key params and returns the new access + rotated refresh token', async () => {
    const { config, fetchFn } = configWithFetch({
      status: 200,
      body: {
        access_token: 'new-access-token',
        expires_in: 86400,
        refresh_token: 'rotated-refresh-token',
        refresh_expires_in: 15552000,
        scope: 'user.info.basic,video.list',
        token_type: 'Bearer',
      },
    })

    const result = await refreshTiktokAccessToken('refresh-me', 'my-client-key', 'my-client-secret', config)

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(String(fetchFn.mock.calls[0]![0])).toBe(TOKEN_URL)
    const init = initAt(fetchFn)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(String(init.body))
    expect(form.get('grant_type')).toBe('refresh_token')
    // TikTok calls the client id `client_key`, not `client_id`.
    expect(form.get('client_key')).toBe('my-client-key')
    expect(form.get('client_secret')).toBe('my-client-secret')
    expect(form.get('refresh_token')).toBe('refresh-me')

    expect(result).toEqual({
      accessToken: 'new-access-token',
      expiresIn: 86400,
      refreshToken: 'rotated-refresh-token',
    })
  })

  it('omits refreshToken from the result when TikTok does not rotate it', async () => {
    const { config } = configWithFetch({ status: 200, body: { access_token: 'tok', expires_in: 3600 } })

    const result = await refreshTiktokAccessToken('r', 'c', 's', config)
    expect(result).toEqual({ accessToken: 'tok', expiresIn: 3600 })
    expect(result).not.toHaveProperty('refreshToken')
  })

  it('defaults expiresIn to 0 when the response omits expires_in', async () => {
    const { config } = configWithFetch({ status: 200, body: { access_token: 'tok' } })

    await expect(refreshTiktokAccessToken('r', 'c', 's', config)).resolves.toEqual({
      accessToken: 'tok',
      expiresIn: 0,
    })
  })

  it('throws a kind=auth TiktokApiError on a non-2xx token response (invalid_grant)', async () => {
    const { config } = configWithFetch({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Refresh token has expired.' },
    })

    const err = await captureError(refreshTiktokAccessToken('r', 'c', 's', config))
    expect(err.status).toBe(400)
    expect(err.kind).toBe('auth')
    expect(err.message).toContain('Refresh token has expired.')
  })

  it('classifies an error field inside a 200 body as kind=auth', async () => {
    const { config } = configWithFetch({
      status: 200,
      body: { error: 'invalid_request', error_description: 'client_key is required' },
    })

    const err = await captureError(refreshTiktokAccessToken('r', 'c', 's', config))
    expect(err.kind).toBe('auth')
    expect(err.message).toContain('client_key is required')
  })

  it('throws kind=auth when the successful response carries no access_token', async () => {
    const { config } = configWithFetch({ status: 200, body: { expires_in: 3600 } })

    const err = await captureError(refreshTiktokAccessToken('r', 'c', 's', config))
    expect(err.kind).toBe('auth')
    expect(err.message).toContain('no access_token')
  })

  it('wraps a transport-level fetch rejection with status 0', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down')
    })
    const config: TiktokApiConfig = { fetch: fetchFn as unknown as typeof fetch }

    const err = await captureError(refreshTiktokAccessToken('r', 'c', 's', config))
    expect(err.status).toBe(0)
    expect(err.kind).toBe('http')
    expect(err.message).toContain('network down')
  })
})
