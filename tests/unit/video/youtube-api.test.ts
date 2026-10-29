// tests/unit/video/youtube-api.test.ts
// Unit coverage for the thin HTTP client in src/video/youtube-api.ts.
// Every network call is exercised through an injected fake `fetch`, so these
// tests assert on the URL shape and headers the client produces, never on
// real Google endpoints.
import { describe, it, expect, vi } from 'vitest'
import {
  queryAnalyticsReports,
  getChannelStatistics,
  refreshAccessToken,
  YoutubeApiError,
} from '../../../src/video/youtube-api'
import type { AnalyticsQueryParams, YoutubeApiConfig } from '../../../src/video/youtube-api'

const ANALYTICS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports'
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

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
 * Build a `YoutubeApiConfig` whose fetch answers with the queued responses,
 * in order, while recording every call for assertions.
 */
function configWithFetch(...responses: StubResponse[]) {
  const queue = [...responses]
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const next = queue.shift()
    if (!next) throw new Error('fake fetch: response queue exhausted')
    return stubResponse(next)
  })
  const config: YoutubeApiConfig = { fetch: fetchFn as unknown as typeof fetch }
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
// Analytics fixtures (v2 columnHeaders shape)
// ---------------------------------------------------------------------------

const dim = (name: string) => ({ name, columnType: 'DIMENSION', dataType: 'STRING' })
const metric = (name: string, dataType = 'INTEGER') => ({ name, columnType: 'METRIC', dataType })

const baseParams: AnalyticsQueryParams = {
  ids: 'channel==CHANNELID',
  startDate: '2026-01-01',
  endDate: '2026-01-07',
  metrics: ['estimatedRevenue', 'views'],
}

// ---------------------------------------------------------------------------
// queryAnalyticsReports — request shape
// ---------------------------------------------------------------------------

describe('queryAnalyticsReports – request construction', () => {
  it('builds the report URL with every URLSearchParams option', async () => {
    const { config, fetchFn } = configWithFetch({
      status: 200,
      body: { columnHeaders: [dim('date'), metric('views')], rows: [], rowCount: 0 },
    })

    await queryAnalyticsReports('token-abc', {
      ...baseParams,
      metrics: ['estimatedRevenue', 'estimatedAdRevenue', 'grossRevenue', 'cpm', 'rpm', 'views'],
      dimensions: ['video', 'date'],
      sort: ['estimatedRevenue', 'views'],
      includeEmptyEntities: true,
      maxResults: 50,
    }, config)

    const url = urlAt(fetchFn)
    expect(`${url.origin}${url.pathname}`).toBe(ANALYTICS_URL)
    const q = url.searchParams
    expect(q.get('ids')).toBe('channel==CHANNELID')
    expect(q.get('startDate')).toBe('2026-01-01')
    expect(q.get('endDate')).toBe('2026-01-07')
    expect(q.get('metrics')).toBe('estimatedRevenue,estimatedAdRevenue,grossRevenue,cpm,rpm,views')
    expect(q.get('dimensions')).toBe('video,date')
    expect(q.get('sort')).toBe('estimatedRevenue,views')
    expect(q.get('include-empty-entities')).toBe('true')
    expect(q.get('max-results')).toBe('50')
  })

  it('omits optional params when empty (no dimensions/sort/entity flags)', async () => {
    const { config, fetchFn } = configWithFetch({ status: 200, body: { rowCount: 0 } })

    await queryAnalyticsReports('token-abc', { ...baseParams, dimensions: [], sort: [] }, config)

    const q = urlAt(fetchFn).searchParams
    expect(q.get('metrics')).toBe('estimatedRevenue,views')
    expect(q.has('dimensions')).toBe(false)
    expect(q.has('sort')).toBe(false)
    expect(q.has('include-empty-entities')).toBe(false)
    expect(q.has('max-results')).toBe(false)
  })

  it('sends GET with a Bearer token and JSON accept header', async () => {
    const { config, fetchFn } = configWithFetch({ status: 200, body: { rowCount: 0 } })

    await queryAnalyticsReports('secret-token', baseParams, config)

    expect(initAt(fetchFn).method).toBe('GET')
    expect(headersAt(fetchFn).Authorization).toBe('Bearer secret-token')
    expect(headersAt(fetchFn).Accept).toBe('application/json')
  })
})

// ---------------------------------------------------------------------------
// queryAnalyticsReports — response parsing
// ---------------------------------------------------------------------------

describe('queryAnalyticsReports – response parsing', () => {
  it('maps columnHeaders+rows to objects, coercing metrics and keeping dimensions as strings', async () => {
    const { config } = configWithFetch({
      status: 200,
      body: {
        columnHeaders: [
          dim('date'),
          metric('views'),
          metric('estimatedRevenue', 'DOUBLE'),
        ],
        rows: [
          ['20260101', '1500', '1.25'],
          ['20260102', '2000', '2.5'],
        ],
        rowCount: 2,
      },
    })

    const report = await queryAnalyticsReports('token-abc', baseParams, config)

    expect(report.columnNames).toEqual(['date', 'views', 'estimatedRevenue'])
    expect(report.rows).toEqual([
      { date: '20260101', views: 1500, estimatedRevenue: 1.25 },
      { date: '20260102', views: 2000, estimatedRevenue: 2.5 },
    ])
    // dimension columns must stay strings, metric columns must be numbers
    expect(typeof report.rows[0]!.date).toBe('string')
    expect(typeof report.rows[0]!.views).toBe('number')
  })

  it('returns an empty rows array for a rowCount: 0 response', async () => {
    const { config } = configWithFetch({
      status: 200,
      body: {
        columnHeaders: [dim('date'), metric('views')],
        rows: [],
        rowCount: 0,
      },
    })

    const report = await queryAnalyticsReports('token-abc', baseParams, config)

    expect(report.columnNames).toEqual(['date', 'views'])
    expect(report.rows).toEqual([])
  })

  it('tolerates a completely empty body (no headers, no rows)', async () => {
    const { config } = configWithFetch({ status: 200, body: {} })

    await expect(queryAnalyticsReports('token-abc', baseParams, config)).resolves.toEqual({
      columnNames: [],
      rows: [],
    })
  })
})

// ---------------------------------------------------------------------------
// queryAnalyticsReports — error classification
// ---------------------------------------------------------------------------

function googleError(status: number, reason: string, message: string): StubResponse {
  return {
    status,
    body: {
      error: {
        code: status,
        message,
        status: 'ERROR',
        errors: [{ domain: 'youtube.analytics', reason, message }],
      },
    },
  }
}

async function captureError(promise: Promise<unknown>): Promise<YoutubeApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(YoutubeApiError)
  return err as YoutubeApiError
}

describe('queryAnalyticsReports – error handling', () => {
  it('classifies a 401 authError reason as kind=auth with the status preserved', async () => {
    const { config } = configWithFetch(googleError(401, 'authError', 'Invalid Credentials'))

    const err = await captureError(queryAnalyticsReports('token-abc', baseParams, config))
    expect(err.status).toBe(401)
    expect(err.kind).toBe('auth')
    expect(err.reason).toBe('authError')
    expect(err.message).toContain('Invalid Credentials')
    expect(err.name).toBe('YoutubeApiError')
  })

  it('classifies HTTP 403 + quotaExceeded as kind=quota', async () => {
    const { config } = configWithFetch(googleError(403, 'quotaExceeded', 'Quota exceeded.'))

    const err = await captureError(queryAnalyticsReports('token-abc', baseParams, config))
    expect(err.status).toBe(403)
    expect(err.kind).toBe('quota')
    expect(err.reason).toBe('quotaExceeded')
  })

  it('classifies HTTP 429 + rateLimitExceeded as kind=rateLimit', async () => {
    const { config } = configWithFetch(googleError(429, 'rateLimitExceeded', 'Rate limit exceeded'))

    const err = await captureError(queryAnalyticsReports('token-abc', baseParams, config))
    expect(err.status).toBe(429)
    expect(err.kind).toBe('rateLimit')
    expect(err.reason).toBe('rateLimitExceeded')
  })

  it('falls back to kind=http and keeps the status for other 5xx failures', async () => {
    const { config } = configWithFetch(googleError(500, 'backendError', 'Internal error'))

    const err = await captureError(queryAnalyticsReports('token-abc', baseParams, config))
    expect(err.status).toBe(500)
    expect(err.kind).toBe('http')
    expect(err.reason).toBe('backendError')
  })

  it('surfaces non-JSON error bodies as a YoutubeApiError, not a parse crash', async () => {
    const { config } = configWithFetch({
      status: 502,
      body: '<html><head><title>Bad Gateway</title></head><body>nginx</body></html>',
    })

    const err = await captureError(queryAnalyticsReports('token-abc', baseParams, config))
    expect(err.status).toBe(502)
    expect(err.kind).toBe('http')
    expect(err.message).toContain('Bad Gateway')
    expect(err.message).toContain('(HTTP 502)')
  })

  it('wraps a transport-level fetch rejection in a YoutubeApiError with status 0', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('socket hang up')
    })
    const config: YoutubeApiConfig = { fetch: fetchFn as unknown as typeof fetch }

    const err = await captureError(queryAnalyticsReports('token-abc', baseParams, config))
    expect(err.status).toBe(0)
    expect(err.kind).toBe('http')
    expect(err.message).toContain('socket hang up')
  })
})

// ---------------------------------------------------------------------------
// getChannelStatistics
// ---------------------------------------------------------------------------

describe('getChannelStatistics', () => {
  it('requests part=statistics for the channel id with a Bearer token', async () => {
    const { config, fetchFn } = configWithFetch({
      status: 200,
      body: {
        items: [
          {
            id: 'UC123',
            statistics: { subscriberCount: '1000', viewCount: '482371', videoCount: '42' },
          },
        ],
      },
    })

    await getChannelStatistics('UC123', 'token-abc', config)

    const url = urlAt(fetchFn)
    expect(`${url.origin}${url.pathname}`).toBe(CHANNELS_URL)
    expect(url.searchParams.get('part')).toBe('statistics')
    expect(url.searchParams.get('id')).toBe('UC123')
    expect(headersAt(fetchFn).Authorization).toBe('Bearer token-abc')
  })

  it('coerces Google\'s string statistics to numbers', async () => {
    const { config } = configWithFetch({
      status: 200,
      body: {
        items: [
          {
            id: 'UC123',
            // Google returns every counter as a decimal string.
            statistics: { subscriberCount: '1000', viewCount: '999999', videoCount: '42' },
          },
        ],
      },
    })

    const stats = await getChannelStatistics('UC123', 'token-abc', config)

    expect(stats).toEqual({ subscriberCount: 1000, totalViews: 999999, videoCount: 42 })
    expect(typeof stats.subscriberCount).toBe('number')
  })

  it('returns zeroed stats when items is empty (no channel-not-found signal)', async () => {
    // Design note: a "channel not found" answer (empty items) is NOT an error
    // here — the client reports zeros, indistinguishable from a real
    // 0-subscriber channel. Flagged for follow-up; see report.
    const { config } = configWithFetch({ status: 200, body: { items: [] } })

    const stats = await getChannelStatistics('UC-missing', 'token-abc', config)

    expect(stats).toEqual({ subscriberCount: 0, totalViews: 0, videoCount: 0 })
  })
})

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------

describe('refreshAccessToken', () => {
  it('POSTs url-encoded refresh params and returns the new access token', async () => {
    const { config, fetchFn } = configWithFetch({
      status: 200,
      body: { access_token: 'new-access-token', expires_in: 3599, scope: 'https://www.googleapis.com/auth/yt-analytics.readonly' },
    })

    const result = await refreshAccessToken('refresh-me', 'my-client-id', 'my-client-secret', config)

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(String(fetchFn.mock.calls[0]![0])).toBe(TOKEN_URL)
    const init = initAt(fetchFn)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(String(init.body))
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('client_id')).toBe('my-client-id')
    expect(form.get('client_secret')).toBe('my-client-secret')
    expect(form.get('refresh_token')).toBe('refresh-me')

    expect(result).toEqual({ accessToken: 'new-access-token', expiresIn: 3599 })
  })

  it('defaults expiresIn to 0 when the response omits expires_in', async () => {
    const { config } = configWithFetch({ status: 200, body: { access_token: 'tok' } })

    await expect(refreshAccessToken('r', 'c', 's', config)).resolves.toEqual({
      accessToken: 'tok',
      expiresIn: 0,
    })
  })

  it('throws a YoutubeApiError on a non-2xx token response', async () => {
    const { config } = configWithFetch({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
    })

    const err = await captureError(refreshAccessToken('r', 'c', 's', config))
    expect(err.status).toBe(400)
  })

  it('classifies an error field inside a 200 body as kind=auth', async () => {
    const { config } = configWithFetch({
      status: 200,
      body: { error: 'access_denied', error_description: 'User revoked consent' },
    })

    const err = await captureError(refreshAccessToken('r', 'c', 's', config))
    expect(err.kind).toBe('auth')
    expect(err.message).toContain('User revoked consent')
  })

  it('throws kind=auth when the successful response carries no access_token', async () => {
    const { config } = configWithFetch({ status: 200, body: { expires_in: 3600 } })

    const err = await captureError(refreshAccessToken('r', 'c', 's', config))
    expect(err.kind).toBe('auth')
    expect(err.message).toContain('no access_token')
  })
})
