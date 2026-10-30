// tests/unit/video/youtube-adapter.test.ts
// Unit coverage for the YouTube platform adapter in
// src/video/platform-adapters/youtube.ts.
//
// All side-effecting collaborators arrive via `YoutubeAdapterDeps`, so the
// adapter under test runs with faked DB readers/writers, a faked transport, and
// REAL AES-GCM helpers from src/video/oauth-encryption.ts: fixtures pack
// genuine ciphertext, and the adapter's internal unpackEncrypted/decryptToken
// path is exercised end-to-end rather than stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The adapter value-imports ../../db/video-queries (which transitively loads
// the pg client); stub the whole module so no pool/env plumbing runs at import
// time. The adapter only uses these functions through the injected deps.
const db = vi.hoisted(() => ({
  getOAuthTokenById: vi.fn(),
  getLatestOAuthToken: vi.fn(),
  updateOAuthToken: vi.fn(),
}))
vi.mock('../../../src/db/video-queries', () => db)

import {
  YoutubeAdapter,
  YoutubeAdapterError,
  YoutubeChannelClient,
  createYoutubeAdapter,
  defaultEncryptAndPack,
  defaultGetEncryptionKey,
} from '../../../src/video/platform-adapters/youtube'
import type { YoutubeAdapterDeps } from '../../../src/video/platform-adapters/youtube'
import {
  decryptToken,
  encryptToken,
  generateEncryptionKey,
  packEncrypted,
  unpackEncrypted,
} from '../../../src/video/oauth-encryption'
import type { OAuthToken } from '../../../src/db/types'
import type { CrumEnv } from '../../../src/config/env'
import type { DateRange } from '../../../src/video/platform-adapters'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const TENANT = 'tenant-1'
const KEY = generateEncryptionKey()

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function envFixture(): CrumEnv {
  return {
    NODE_ENV: 'test',
    VIDEO_YOUTUBE_CLIENT_ID: 'client-id',
    VIDEO_YOUTUBE_CLIENT_SECRET: 'client-secret',
    OAUTH_ENCRYPTION_KEY: KEY.toString('hex'),
  } as unknown as CrumEnv
}

/** Real pack/encrypt: the adapter must be able to unpack+decrypt these. */
function packToken(plaintext: string): string {
  const { encrypted, iv, tag } = encryptToken(plaintext, KEY)
  return packEncrypted(encrypted, iv, tag).toString('base64url')
}

interface RowOptions {
  id?: string
  accessToken?: string
  refreshToken?: string | null
  expiresAt?: string | null
}

function tokenRow(options: RowOptions = {}): OAuthToken {
  return {
    id: options.id ?? 'tok-1',
    tenant_id: TENANT,
    platform: 'youtube',
    access_token_encrypted: packToken(options.accessToken ?? 'fresh-access-token'),
    refresh_token_encrypted:
      options.refreshToken === null ? null : packToken(options.refreshToken ?? 'stored-refresh-token'),
    // Far future ⇒ needsRefresh() is false unless a test wants otherwise.
    expires_at: options.expiresAt ?? '2099-01-01T00:00:00.000Z',
    scope: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

const dim = (name: string) => ({ name, columnType: 'DIMENSION', dataType: 'STRING' })
const metric = (name: string, dataType = 'INTEGER') => ({ name, columnType: 'METRIC', dataType })

function analyticsBody(columnHeaders: unknown[], rows: unknown[][]) {
  return { columnHeaders, rows, rowCount: rows.length }
}

function stubResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    // Non-async on purpose: `Response#text()` returns a Promise, but the fixture
    // body is already in memory, so there is nothing to await.
    text: () => JSON.stringify(body),
  } as unknown as Response
}

/**
 * The requested URL as text. The adapter always passes a `string` href; URL and
 * Request are resolved by field instead of `String(input)`, which would turn a
 * Request into `[object Object]`.
 */
function requestUrlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/**
 * The adapter posts token refreshes as a url-encoded `string` body, so the
 * recorded body is narrowed to that instead of stringified via
 * `String(BodyInit)`.
 */
function bodyTextAt(fetchImpl: typeof fetch, index = 0): string {
  const body = vi.mocked(fetchImpl).mock.calls[index]![1]?.body
  if (typeof body !== 'string') {
    throw new Error(`fake fetch: expected a string request body, got ${typeof body}`)
  }
  return body
}

/**
 * Router-style fake fetch: each call picks the first matcher whose predicate
 * accepts the URL and pops the next queued response for that route.
 */
interface Route {
  match: (url: string) => boolean
  responses: Array<{ status: number; body: unknown }>
}

function makeFetch(routes: Route[]) {
  // The parameters describe the recorded call tuple; the body is a plain
  // `Promise.resolve`, so an `async` wrapper would have nothing to await.
  const fetchFn = vi.fn((input: string | URL | Request): Promise<Response> => {
    const url = requestUrlOf(input)
    for (const route of routes) {
      if (route.match(url)) {
        const next = route.responses.shift()
        if (!next) throw new Error(`fake fetch: route exhausted for ${url}`)
        return Promise.resolve(stubResponse(next.status, next.body))
      }
    }
    throw new Error(`fake fetch: unexpected URL ${url}`)
  })
  return fetchFn as unknown as typeof fetch
}

const isAnalytics = (url: string) => url.startsWith('https://youtubeanalytics.googleapis.com')
const isToken = (url: string) => url.startsWith(TOKEN_URL)

function analyticsQueryAt(fetchImpl: ReturnType<typeof makeFetch>, index = 0): URLSearchParams {
  return new URL(requestUrlOf(vi.mocked(fetchImpl).mock.calls[index]![0])).searchParams
}

function authHeaderAt(fetchImpl: ReturnType<typeof makeFetch>, index = 0): string {
  const headers = vi.mocked(fetchImpl).mock.calls[index]![1]!.headers as Record<string, string | undefined>
  return headers.Authorization ?? ''
}

// ---------------------------------------------------------------------------
// Deps factory
// ---------------------------------------------------------------------------

interface DepsOverrides {
  fetch?: typeof fetch
  encryptAndPack?: (plaintext: string, key: Buffer) => string
}

function buildDeps(overrides: DepsOverrides = {}): YoutubeAdapterDeps {
  return {
    env: envFixture(),
    getOAuthTokenById: db.getOAuthTokenById,
    getLatestOAuthToken: db.getLatestOAuthToken,
    updateOAuthToken: db.updateOAuthToken,
    // Deterministic sentinel so updateOAuthToken arguments can be asserted
    // exactly; real re-encryption is covered separately via defaultEncryptAndPack.
    encryptAndPack: overrides.encryptAndPack ?? ((plaintext) => `PACKED(${plaintext})`),
    // Same real key the fixtures were packed with — decrypt runs for real.
    getEncryptionKey: () => KEY,
    api: { fetch: overrides.fetch ?? makeFetch([]) },
  }
}

const RANGE: DateRange = { start: '2026-01-01', end: '2026-01-01' }

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('YoutubeAdapter – basics', () => {
  it('reports platform=youtube', () => {
    expect(new YoutubeAdapter(buildDeps(), TENANT).platform).toBe('youtube')
  })

  it('createYoutubeAdapter wires default deps behind the same interface', () => {
    const adapter = createYoutubeAdapter(envFixture(), TENANT)
    expect(adapter).toBeInstanceOf(YoutubeAdapter)
    expect(adapter.platform).toBe('youtube')
  })

  it('fetchEarnings fails with a clear error when the tenant has no token row', async () => {
    db.getLatestOAuthToken.mockResolvedValue(null)
    const adapter = new YoutubeAdapter(buildDeps(), TENANT)

    await expect(adapter.fetchEarnings('UC-xyz', RANGE)).rejects.toThrow(YoutubeAdapterError)
    await expect(adapter.fetchEarnings('UC-xyz', RANGE)).rejects.toThrow(/No YouTube OAuth token found/)
  })
})

describe('default encryption helpers', () => {
  it('defaultGetEncryptionKey reads the hex key from env', () => {
    expect(defaultGetEncryptionKey(envFixture())).toEqual(KEY)
  })

  it('defaultGetEncryptionKey throws when the key is missing', () => {
    expect(() => defaultGetEncryptionKey({} as CrumEnv)).toThrow(/OAUTH_ENCRYPTION_KEY/)
  })

  it('defaultEncryptAndPack produces base64url iv||ct||tag that unpack+decrypt round-trips', () => {
    const packed = defaultEncryptAndPack('a-token', KEY)
    const { encrypted, iv, tag } = unpackEncrypted(Buffer.from(packed, 'base64url'))
    expect(decryptToken(encrypted, KEY, iv, tag)).toBe('a-token')
  })
})

// ---------------------------------------------------------------------------
// fetchEarnings
// ---------------------------------------------------------------------------

describe('YoutubeAdapter.fetchEarnings', () => {
  beforeEach(() => {
    db.getLatestOAuthToken.mockResolvedValue(tokenRow())
    db.getOAuthTokenById.mockResolvedValue(tokenRow())
  })

  it('maps every analytics row to an EarningsRecord with micros, currency and impressions=views', async () => {
    const fetchImpl = makeFetch([
      {
        match: isAnalytics,
        responses: [
          {
            status: 200,
            body: analyticsBody(
              [dim('date'), metric('estimatedRevenue', 'DOUBLE'), metric('estimatedAdRevenue', 'DOUBLE'), metric('grossRevenue', 'DOUBLE'), metric('cpm', 'DOUBLE'), metric('rpm', 'DOUBLE'), metric('views')],
              [
                ['20260101', '1.5', '1.2', '1.8', '0.7', '12', '5000'],
                ['20260102', '0', '0', '0', '0', '0', '10'],
              ],
            ),
          },
        ],
      },
    ])
    const adapter = new YoutubeAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchEarnings('UC-abc', { start: '2026-01-01', end: '2026-01-02' })

    expect(data.channelId).toBe('UC-abc')
    expect(data.platform).toBe('youtube')
    expect(data.dateRange).toEqual({ start: '2026-01-01', end: '2026-01-02' })
    expect(data.records).toEqual([
      {
        date: '2026-01-01',
        revenue_micros: 1_500_000,
        currency: 'USD',
        impressions: 5000,
        estimated_revenue: 1.5,
      },
      {
        date: '2026-01-02',
        revenue_micros: 0,
        currency: 'USD',
        impressions: 10,
        estimated_revenue: 0,
      },
    ])

    // The monetary metric set is requested, scoped to the day dimension.
    const q = analyticsQueryAt(fetchImpl)
    expect(q.get('metrics')).toBe('estimatedRevenue,estimatedAdRevenue,grossRevenue,cpm,rpm,views')
    expect(q.get('dimensions')).toBe('date')
    expect(q.get('ids')).toBe('channel==UC-abc')
    expect(authHeaderAt(fetchImpl)).toBe('Bearer fresh-access-token')
  })

  it('retries without monetary metrics after a scope-denied 403 and persists zero revenue', async () => {
    const denied = {
      status: 403,
      body: {
        error: {
          code: 403,
          message:
            'Insufficient Permission: monetary metrics require the yt-analytics-monetary.readonly scope',
          errors: [{ domain: 'youtube.analytics', reason: 'insufficientPermissions' }],
        },
      },
    }
    const fetchImpl = makeFetch([
      {
        match: isAnalytics,
        responses: [
          denied,
          {
            status: 200,
            body: analyticsBody([dim('date'), metric('views')], [['20260101', '5000']]),
          },
        ],
      },
    ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapter = new YoutubeAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchEarnings('UC-abc', RANGE)

    expect(data.records).toEqual([
      {
        date: '2026-01-01',
        revenue_micros: 0,
        currency: 'USD',
        impressions: 5000,
        estimated_revenue: 0,
      },
    ])
    // Second attempt must ask for the non-monetary metrics only.
    expect(analyticsQueryAt(fetchImpl, 1).get('metrics')).toBe('views')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('zero revenue'))
    warnSpy.mockRestore()
  })

  it('propagates errors that are not monetary-scope denials (e.g. quota)', async () => {
    const fetchImpl = makeFetch([
      {
        match: isAnalytics,
        responses: [
          {
            status: 403,
            body: {
              error: {
                code: 403,
                message: 'Quota exceeded.',
                errors: [{ reason: 'quotaExceeded' }],
              },
            },
          },
        ],
      },
    ])
    const adapter = new YoutubeAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    await expect(adapter.fetchEarnings('UC-abc', RANGE)).rejects.toThrow(/Quota exceeded/)
    // Exactly one analytics call: no silent retry for quota errors.
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// fetchAudienceMetrics
// ---------------------------------------------------------------------------

describe('YoutubeAdapter.fetchAudienceMetrics', () => {
  beforeEach(() => {
    db.getLatestOAuthToken.mockResolvedValue(tokenRow())
    db.getOAuthTokenById.mockResolvedValue(tokenRow())
  })

  it('parses daily activity rows and attaches _perVideo where the breakdown has data', async () => {
    const fetchImpl = makeFetch([
      {
        match: isAnalytics,
        responses: [
          {
            status: 200,
            body: analyticsBody(
              [dim('date'), metric('views'), metric('estimatedMinutesWatched', 'DOUBLE'), metric('subscribersGained'), metric('subscribersLost')],
              [
                ['20260101', '5000', '1200.5', '30', '5'],
                ['20260102', '100', '20', '1', '0'],
              ],
            ),
          },
          {
            status: 200,
            body: analyticsBody(
              [dim('video'), dim('date'), metric('views'), metric('estimatedMinutesWatched', 'DOUBLE'), metric('estimatedRevenue', 'DOUBLE'), metric('cpm', 'DOUBLE'), metric('rpm', 'DOUBLE')],
              [
                ['vid-1', '20260101', '3000', '700', '0.9', '0.3', '9'],
                ['vid-2', '20260101', '2000', '500.5', '0.6', '0.3', '8'],
              ],
            ),
          },
        ],
      },
    ])
    const adapter = new YoutubeAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchAudienceMetrics('UC-abc', { start: '2026-01-01', end: '2026-01-02' })

    // Query 1: daily activity; query 2: best-effort per-video breakdown.
    expect(analyticsQueryAt(fetchImpl, 0).get('metrics')).toBe(
      'views,estimatedMinutesWatched,subscribersGained,subscribersLost',
    )
    expect(analyticsQueryAt(fetchImpl, 0).get('dimensions')).toBe('date')
    expect(analyticsQueryAt(fetchImpl, 1).get('dimensions')).toBe('video,date')

    expect(data.channelId).toBe('UC-abc')
    expect(data.platform).toBe('youtube')
    expect(data.records).toHaveLength(2)

    const [first, second] = data.records
    expect(first).toEqual({
      date: '2026-01-01',
      views: 5000,
      watchTimeMinutes: 1200.5,
      subscribersGained: 30,
      subscribersLost: 5,
      likes: 0,
      comments: 0,
      shares: 0,
      _perVideo: [
        {
          videoId: 'vid-1',
          date: '2026-01-01',
          views: 3000,
          watchTimeMinutes: 700,
          estimatedRevenue: 0.9,
          cpm: 0.3,
          rpm: 9,
        },
        {
          videoId: 'vid-2',
          date: '2026-01-01',
          views: 2000,
          watchTimeMinutes: 500.5,
          estimatedRevenue: 0.6,
          cpm: 0.3,
          rpm: 8,
        },
      ],
    })
    // Day without per-video rows carries no _perVideo key at all.
    expect(second).toEqual({
      date: '2026-01-02',
      views: 100,
      watchTimeMinutes: 20,
      subscribersGained: 1,
      subscribersLost: 0,
      likes: 0,
      comments: 0,
      shares: 0,
    })
  })

  it('keeps daily rows when the per-video breakdown fails, logging a warning', async () => {
    const fetchImpl = makeFetch([
      {
        match: isAnalytics,
        responses: [
          {
            status: 200,
            body: analyticsBody(
              [dim('date'), metric('views'), metric('estimatedMinutesWatched'), metric('subscribersGained'), metric('subscribersLost')],
              [['20260101', '5000', '1200', '30', '5']],
            ),
          },
          { status: 500, body: { error: { code: 500, message: 'backendError' } } },
        ],
      },
    ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapter = new YoutubeAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchAudienceMetrics('UC-abc', RANGE)

    expect(data.records).toHaveLength(1)
    expect(data.records[0]!.views).toBe(5000)
    expect(data.records[0]).not.toHaveProperty('_perVideo')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('per-video breakdown unavailable'))
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// refreshOAuthToken
// ---------------------------------------------------------------------------

describe('YoutubeAdapter.refreshOAuthToken', () => {
  it('decrypts the stored refresh token for real, calls the token endpoint, and writes back the new access token', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'))

    db.getOAuthTokenById.mockResolvedValue(tokenRow({ refreshToken: 'stored-refresh-token' }))
    const encryptAndPack = vi.fn((plaintext: string) => `PACKED(${plaintext})`)
    const fetchImpl = makeFetch([
      {
        match: isToken,
        responses: [{ status: 200, body: { access_token: 'brand-new-token', expires_in: 3600 } }],
      },
    ])
    const adapter = new YoutubeAdapter(buildDeps({ fetch: fetchImpl, encryptAndPack }), TENANT)

    await adapter.refreshOAuthToken('tok-1')

    // Real decrypt happened: the form body carries the plaintext refresh token.
    const formBody = bodyTextAt(fetchImpl)
    expect(formBody).toBeTruthy()
    const form = new URLSearchParams(formBody)
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('client_id')).toBe('client-id')
    expect(form.get('client_secret')).toBe('client-secret')
    expect(form.get('refresh_token')).toBe('stored-refresh-token')

    // Re-encryption ran through the injected fake, with the decrypted key.
    expect(encryptAndPack).toHaveBeenCalledWith('brand-new-token', KEY)

    // Exact write-back: tenant + token row + packed access token + expiry.
    expect(db.updateOAuthToken).toHaveBeenCalledWith(TENANT, 'tok-1', {
      accessTokenEnc: 'PACKED(brand-new-token)',
      expiresAt: '2026-06-01T13:00:00.000Z',
    })
    // Refresh is row-scoped: the "latest token" lookup must not be consulted.
    expect(db.getLatestOAuthToken).not.toHaveBeenCalled()
  })

  it('throws a clear YoutubeAdapterError when the row has no stored refresh token', async () => {
    db.getOAuthTokenById.mockResolvedValue(tokenRow({ refreshToken: null }))
    const fetchImpl = makeFetch([])
    const adapter = new YoutubeAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    await expect(adapter.refreshOAuthToken('tok-1')).rejects.toThrow(YoutubeAdapterError)
    await expect(adapter.refreshOAuthToken('tok-1')).rejects.toThrow(/must be re-connected/)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(db.updateOAuthToken).not.toHaveBeenCalled()
  })

  it('throws when the token row is missing for the tenant', async () => {
    db.getOAuthTokenById.mockResolvedValue(null)
    const adapter = new YoutubeAdapter(buildDeps(), TENANT)

    await expect(adapter.refreshOAuthToken('tok-404')).rejects.toThrow(/not found for tenant/)
  })

  it('fails fast when the OAuth client credentials are not configured', async () => {
    db.getOAuthTokenById.mockResolvedValue(tokenRow())
    const deps = buildDeps()
    deps.env = { NODE_ENV: 'test' } as unknown as CrumEnv
    const adapter = new YoutubeAdapter(deps, TENANT)

    await expect(adapter.refreshOAuthToken('tok-1')).rejects.toThrow(/VIDEO_YOUTUBE_CLIENT_ID/)
  })
})

// ---------------------------------------------------------------------------
// 401 recovery: refresh once, then retry
// ---------------------------------------------------------------------------

describe('YoutubeAdapter 401 refresh-and-retry', () => {
  it('refreshes the token on a 401 and retries the report exactly once', async () => {
    db.getLatestOAuthToken.mockResolvedValue(tokenRow({ accessToken: 'stale-access-token' }))
    const staleRow = tokenRow({ accessToken: 'stale-access-token' })
    const rotatedRow = tokenRow({ accessToken: 'rotated-access' })
    // 1st load: pre-query check; 2nd: inside refreshTokenRow; 3rd: post-refresh reload.
    db.getOAuthTokenById
      .mockResolvedValueOnce(staleRow)
      .mockResolvedValueOnce(staleRow)
      .mockResolvedValueOnce(rotatedRow)

    const fetchImpl = makeFetch([
      {
        match: isAnalytics,
        responses: [
          {
            status: 401,
            body: {
              error: {
                code: 401,
                message: 'Invalid Credentials',
                errors: [{ reason: 'authError', domain: 'global' }],
              },
            },
          },
          {
            status: 200,
            body: analyticsBody(
              [dim('date'), metric('estimatedRevenue', 'DOUBLE'), metric('views')],
              [['20260101', '2.5', '7000']],
            ),
          },
        ],
      },
      {
        match: isToken,
        responses: [{ status: 200, body: { access_token: 'rotated-access', expires_in: 3600 } }],
      },
    ])
    const adapter = new YoutubeAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchEarnings('UC-abc', RANGE)

    // Order: analytics(401) → token refresh → analytics(retry). One retry only.
    const urls = vi.mocked(fetchImpl).mock.calls.map((c) => requestUrlOf(c[0]))
    expect(urls).toHaveLength(3)
    expect(isAnalytics(urls[0]!)).toBe(true)
    expect(urls[1]!.startsWith(TOKEN_URL)).toBe(true)
    expect(isAnalytics(urls[2]!)).toBe(true)

    // The retry authenticates with the rotated access token (written back by
    // the refresh flow and re-read from the mocked row), not the stale one.
    expect(authHeaderAt(fetchImpl, 0)).toBe('Bearer stale-access-token')
    expect(authHeaderAt(fetchImpl, 2)).toBe('Bearer rotated-access')

    expect(db.updateOAuthToken).toHaveBeenCalledTimes(1)
    expect(data.records[0]).toEqual({
      date: '2026-01-01',
      revenue_micros: 2_500_000,
      currency: 'USD',
      impressions: 7000,
      estimated_revenue: 2.5,
    })
  })
})

// ---------------------------------------------------------------------------
// withChannel – bound client
// ---------------------------------------------------------------------------

describe('YoutubeAdapter.withChannel', () => {
  it('binds an explicit token row, resolves it by id (never latest), and scopes ids to the bound channel', async () => {
    db.getOAuthTokenById.mockResolvedValue(tokenRow({ id: 'tok-explicit', accessToken: 'bound-access' }))
    const fetchImpl = makeFetch([
      {
        match: isAnalytics,
        responses: [
          {
            status: 200,
            body: analyticsBody(
              [dim('date'), metric('estimatedRevenue', 'DOUBLE'), metric('views')],
              [['20260101', '0.25', '300']],
            ),
          },
        ],
      },
    ])
    const adapter = new YoutubeAdapter(buildDeps({ fetch: fetchImpl }), TENANT)
    const client = adapter.withChannel(TENANT, 'tok-explicit', 'UC-bound')

    expect(client).toBeInstanceOf(YoutubeChannelClient)

    const data = await client.fetchEarnings(RANGE)

    expect(db.getLatestOAuthToken).not.toHaveBeenCalled()
    expect(db.getOAuthTokenById).toHaveBeenCalledWith(TENANT, 'tok-explicit')
    expect(analyticsQueryAt(fetchImpl).get('ids')).toBe('channel==UC-bound')
    expect(authHeaderAt(fetchImpl)).toBe('Bearer bound-access')
    expect(data.records[0]!.revenue_micros).toBe(250_000)
  })
})
