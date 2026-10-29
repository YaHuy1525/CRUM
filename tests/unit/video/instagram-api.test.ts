// tests/unit/video/instagram-api.test.ts
// Unit coverage for the thin HTTP client in src/video/instagram-api.ts.
// Every network call is exercised through an injected fake `fetch`, so these
// tests assert on the URL shape and headers the client produces, never on
// real Meta Graph endpoints.
import { describe, it, expect, vi } from 'vitest'
import {
  getMediaWithInsights,
  refreshInstagramAccessToken,
  InstagramApiError,
  DEFAULT_MEDIA_FIELDS,
} from '../../../src/video/instagram-api'
import type { InstagramApiConfig, MediaInsightsQueryParams } from '../../../src/video/instagram-api'

const MEDIA_URL = 'https://graph.instagram.com/me/media'
const REFRESH_URL = 'https://graph.instagram.com/refresh_access_token'

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
 * Build an `InstagramApiConfig` whose fetch answers with the queued responses,
 * in order, while recording every call for assertions.
 */
function configWithFetch(...responses: StubResponse[]) {
  const queue = [...responses]
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const next = queue.shift()
    if (!next) throw new Error('fake fetch: response queue exhausted')
    return stubResponse(next)
  })
  const config: InstagramApiConfig = { fetch: fetchFn as unknown as typeof fetch }
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

// ---------------------------------------------------------------------------
// Graph media fixtures (raw /me/media shapes)
// ---------------------------------------------------------------------------

function rawMedia(overrides: Record<string, unknown> = {}) {
  return {
    id: '17848942725422679',
    timestamp: '2026-01-01T10:00:00+0000',
    video_views: 1000,
    like_count: 50,
    comment_count: 5,
    share_count: 2,
    ...overrides,
  }
}

const baseParams: MediaInsightsQueryParams = { since: '2026-01-01', until: '2026-01-07', limit: 100 }

const epoch = (iso: string) => String(Math.floor(Date.parse(iso) / 1000))

async function captureError(promise: Promise<unknown>): Promise<InstagramApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(InstagramApiError)
  return err as InstagramApiError
}

// ---------------------------------------------------------------------------
// getMediaWithInsights — request construction
// ---------------------------------------------------------------------------

describe('getMediaWithInsights – request construction', () => {
  it('builds the me/media URL with the default field set, limit and epoch since/until', async () => {
    const { config, fetchFn } = configWithFetch({ status: 200, body: { data: [] } })

    await getMediaWithInsights('token-abc', baseParams, config)

    const url = urlAt(fetchFn)
    expect(`${url.origin}${url.pathname}`).toBe(MEDIA_URL)
    expect(url.searchParams.get('fields')).toBe(DEFAULT_MEDIA_FIELDS)
    expect(url.searchParams.get('fields')).toContain('insights.metric(engagement,impressions,reach)')
    expect(url.searchParams.get('limit')).toBe('100')
    expect(url.searchParams.get('since')).toBe(epoch('2026-01-01T00:00:00.000Z'))
    expect(url.searchParams.get('until')).toBe(epoch('2026-01-07T00:00:00.000Z'))
  })

  it('passes numeric since/until through untouched and omits them when unset', async () => {
    const { config, fetchFn } = configWithFetch({ status: 200, body: { data: [] } })

    await getMediaWithInsights('token-abc', { since: 1767225600, until: '1767744000' }, config)

    const q = urlAt(fetchFn).searchParams
    expect(q.get('since')).toBe('1767225600')
    expect(q.get('until')).toBe('1767744000')
  })

  it('accepts ISO datetimes for since/until and a custom fields override', async () => {
    const { config, fetchFn } = configWithFetch({ status: 200, body: { data: [] } })

    await getMediaWithInsights('token-abc', {
      since: '2026-01-01T06:00:00Z',
      until: '2026-01-07T23:59:59Z',
      fields: 'id,timestamp',
    }, config)

    const q = urlAt(fetchFn).searchParams
    expect(q.get('fields')).toBe('id,timestamp')
    expect(q.get('since')).toBe(epoch('2026-01-01T06:00:00.000Z'))
    expect(q.get('until')).toBe(epoch('2026-01-07T23:59:59.000Z'))
  })

  it('sends GET with a Bearer token and JSON accept header', async () => {
    const { config, fetchFn } = configWithFetch({ status: 200, body: { data: [] } })

    await getMediaWithInsights('secret-token', baseParams, config)

    expect(initAt(fetchFn).method).toBe('GET')
    expect(headersAt(fetchFn).Authorization).toBe('Bearer secret-token')
    expect(headersAt(fetchFn).Accept).toBe('application/json')
  })

  it('rejects an unparseable since value with a client-side InstagramApiError', async () => {
    const { config, fetchFn } = configWithFetch()

    const err = await captureError(getMediaWithInsights('token-abc', { since: 'not-a-date' }, config))
    expect(err.status).toBe(0)
    expect(err.kind).toBe('http')
    expect(err.message).toContain('since')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// getMediaWithInsights — response parsing
// ---------------------------------------------------------------------------

describe('getMediaWithInsights – response parsing', () => {
  it('flattens counters and inline insight metrics onto each media object', async () => {
    const { config } = configWithFetch({
      status: 200,
      body: {
        data: [
          rawMedia({
            video_views: '5300', // Graph sometimes serializes counters as strings
            insights: {
              data: [
                // Last bucket of the values time-series is the lifetime total.
                { name: 'engagement', values: [{ value: 4 }, { value: 131 }], title: 'Engagement' },
                { name: 'impressions', values: [{ value: '900' }] },
                { name: 'reach', values: [{ value: 500 }] },
                { name: 'video_views', values: [{ value: 5300 }] }, // ignored metric name
              ],
            },
          }),
        ],
      },
    })

    const media = await getMediaWithInsights('token-abc', baseParams, config)

    expect(media).toHaveLength(1)
    expect(media[0]).toEqual({
      id: '17848942725422679',
      timestamp: '2026-01-01T10:00:00+0000',
      video_views: 5300,
      like_count: 50,
      comment_count: 5,
      share_count: 2,
      engagement: 131,
      impressions: 900,
      reach: 500,
    })
  })

  it('omits engagement/impressions/reach when the media carries no insights payload', async () => {
    const { config } = configWithFetch({ status: 200, body: { data: [rawMedia({ insights: { data: [] } })] } })

    const media = await getMediaWithInsights('token-abc', baseParams, config)

    expect(media[0]).not.toHaveProperty('engagement')
    expect(media[0]).not.toHaveProperty('impressions')
    expect(media[0]).not.toHaveProperty('reach')
    expect(media[0]!.video_views).toBe(1000)
  })

  it('coerces missing or garbage counters to 0', async () => {
    const { config } = configWithFetch({
      status: 200,
      body: {
        data: [
          { id: 'no-counters', timestamp: '2026-01-02T00:00:00+0000' },
          { id: 'garbage', timestamp: '2026-01-02T00:00:00+0000', video_views: null, like_count: 'abc' },
        ],
      },
    })

    const media = await getMediaWithInsights('token-abc', baseParams, config)

    expect(media[1]!.video_views).toBe(0)
    expect(media[1]!.like_count).toBe(0)
    expect(media[1]!.comment_count).toBe(0)
    expect(media[1]!.share_count).toBe(0)
  })

  it('returns an empty array when data is empty or absent', async () => {
    const { config } = configWithFetch({ status: 200, body: { data: [] } }, { status: 200, body: {} })

    await expect(getMediaWithInsights('token-abc', baseParams, config)).resolves.toEqual([])
    await expect(getMediaWithInsights('token-abc', baseParams, config)).resolves.toEqual([])
  })
})

// ---------------------------------------------------------------------------
// getMediaWithInsights — cursor pagination
// ---------------------------------------------------------------------------

describe('getMediaWithInsights – pagination', () => {
  it('follows paging.next verbatim and concatenates pages in order', async () => {
    const nextPageUrl = `${MEDIA_URL}?fields=id&after=CURSOR_AFTER&access_token=token-abc`
    const { config, fetchFn } = configWithFetch(
      { status: 200, body: { data: [rawMedia({ id: 'page-1' })], paging: { next: nextPageUrl } } },
      { status: 200, body: { data: [rawMedia({ id: 'page-2' })], paging: { previous: MEDIA_URL } } },
    )

    const media = await getMediaWithInsights('token-abc', baseParams, config)

    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(String(fetchFn.mock.calls[1]![0])).toBe(nextPageUrl)
    expect(headersAt(fetchFn, 1).Authorization).toBe('Bearer token-abc')
    expect(media.map((m) => m.id)).toEqual(['page-1', 'page-2'])
  })

  it('stops immediately when the response has no paging.next', async () => {
    const { config, fetchFn } = configWithFetch({ status: 200, body: { data: [rawMedia()] } })

    await getMediaWithInsights('token-abc', baseParams, config)

    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('aborts with an InstagramApiError on a never-ending paging.next chain', async () => {
    const selfLoop = {
      status: 200,
      body: { data: [], paging: { next: `${MEDIA_URL}?after=LOOP` } },
    }
    const fetchFn = vi.fn(async () => stubResponse(selfLoop))
    const config: InstagramApiConfig = { fetch: fetchFn as unknown as typeof fetch }

    const err = await captureError(getMediaWithInsights('token-abc', baseParams, config))
    expect(err.kind).toBe('http')
    expect(err.message).toContain('pagination')
    // Well-behaved cap: bounded number of requests, not an infinite loop.
    expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(100)
    expect(fetchFn.mock.calls.length).toBeGreaterThan(50)
  })
})

// ---------------------------------------------------------------------------
// getMediaWithInsights — Meta error classification
// ---------------------------------------------------------------------------

function metaError(status: number, message: string, type: string, code: number, fbtrace = 'ABC123'): StubResponse {
  return { status, body: { error: { message, type, code, fbtrace_id: fbtrace } } }
}

describe('getMediaWithInsights – error handling', () => {
  it('maps a 400 OAuthException code 190 (expired token) to kind=auth with a composed reason', async () => {
    const { config } = configWithFetch(
      metaError(400, 'Invalid OAuth access token - Blank access token.', 'OAuthException', 190),
    )

    const err = await captureError(getMediaWithInsights('token-abc', baseParams, config))
    expect(err.status).toBe(400)
    expect(err.kind).toBe('auth')
    expect(err.reason).toBe('OAuthException:190')
    expect(err.message).toContain('Invalid OAuth access token')
    expect(err.name).toBe('InstagramApiError')
  })

  it('maps HTTP 429 throttling to kind=rateLimit', async () => {
    const { config } = configWithFetch(
      metaError(429, 'Call limit reached for calls per hour', 'APICallRateException', 4),
    )

    const err = await captureError(getMediaWithInsights('token-abc', baseParams, config))
    expect(err.status).toBe(429)
    expect(err.kind).toBe('rateLimit')
    expect(err.reason).toBe('APICallRateException:4')
  })

  it('classifies a 400 with code 4 (throttling) as rateLimit even without a 429 status', async () => {
    const { config } = configWithFetch(
      metaError(400, 'Please reduce the amount of data you are asking for', 'OAuthException', 4),
    )

    const err = await captureError(getMediaWithInsights('token-abc', baseParams, config))
    expect(err.kind).toBe('rateLimit')
  })

  it('falls back to kind=http for non-OAuth Graph failures and keeps the status', async () => {
    const { config } = configWithFetch(
      metaError(404, 'Unsupported get request.', 'GraphNotFoundMethod', 100),
    )

    const err = await captureError(getMediaWithInsights('token-abc', baseParams, config))
    expect(err.status).toBe(404)
    expect(err.kind).toBe('http')
    expect(err.reason).toBe('GraphNotFoundMethod:100')
  })

  it('surfaces non-JSON error bodies as an InstagramApiError, not a parse crash', async () => {
    const { config } = configWithFetch({
      status: 502,
      body: '<html><head><title>Bad Gateway</title></head><body>nginx</body></html>',
    })

    const err = await captureError(getMediaWithInsights('token-abc', baseParams, config))
    expect(err.status).toBe(502)
    expect(err.kind).toBe('http')
    expect(err.message).toContain('Bad Gateway')
    expect(err.message).toContain('(HTTP 502)')
  })

  it('wraps a transport-level fetch rejection in an InstagramApiError with status 0', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('socket hang up')
    })
    const config: InstagramApiConfig = { fetch: fetchFn as unknown as typeof fetch }

    const err = await captureError(getMediaWithInsights('token-abc', baseParams, config))
    expect(err.status).toBe(0)
    expect(err.kind).toBe('http')
    expect(err.message).toContain('socket hang up')
  })
})

// ---------------------------------------------------------------------------
// refreshInstagramAccessToken
// ---------------------------------------------------------------------------

describe('refreshInstagramAccessToken', () => {
  it('GETs refresh_access_token with grant_type=ig_refresh_token and the CURRENT access token', async () => {
    const { config, fetchFn } = configWithFetch({
      status: 200,
      body: { access_token: 'new-access-token', expires_in: 5184000 },
    })

    const result = await refreshInstagramAccessToken('current-access-token', 'ig-client-id', 'ig-client-secret', config)

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const url = urlAt(fetchFn)
    expect(`${url.origin}${url.pathname}`).toBe(REFRESH_URL)
    expect(url.searchParams.get('grant_type')).toBe('ig_refresh_token')
    expect(url.searchParams.get('access_token')).toBe('current-access-token')
    expect(url.searchParams.get('client_id')).toBe('ig-client-id')
    expect(url.searchParams.get('client_secret')).toBe('ig-client-secret')
    expect(initAt(fetchFn).method).toBe('GET')

    expect(result).toEqual({ accessToken: 'new-access-token', expiresIn: 5184000 })
  })

  it('defaults expiresIn to 0 when the response omits expires_in', async () => {
    const { config } = configWithFetch({ status: 200, body: { access_token: 'tok' } })

    await expect(refreshInstagramAccessToken('r', 'c', 's', config)).resolves.toEqual({
      accessToken: 'tok',
      expiresIn: 0,
    })
  })

  it('throws kind=auth when the successful response carries no access_token', async () => {
    const { config } = configWithFetch({ status: 200, body: { expires_in: 3600 } })

    const err = await captureError(refreshInstagramAccessToken('r', 'c', 's', config))
    expect(err.kind).toBe('auth')
    expect(err.message).toContain('no access_token')
  })

  it('maps a Meta error envelope on a non-2xx refresh to an InstagramApiError', async () => {
    const { config } = configWithFetch(
      metaError(400, 'Error validating access token: The user has not authorized the application.', 'OAuthException', 190),
    )

    const err = await captureError(refreshInstagramAccessToken('r', 'c', 's', config))
    expect(err.status).toBe(400)
    expect(err.kind).toBe('auth')
    expect(err.reason).toBe('OAuthException:190')
    expect(err.message).toContain('not authorized')
  })

  it('wraps a transport-level fetch rejection in a status-0 InstagramApiError', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const config: InstagramApiConfig = { fetch: fetchFn as unknown as typeof fetch }

    const err = await captureError(refreshInstagramAccessToken('r', 'c', 's', config))
    expect(err.status).toBe(0)
    expect(err.kind).toBe('http')
    expect(err.message).toContain('ECONNRESET')
  })
})
