// tests/unit/video/instagram-adapter.test.ts
// Unit coverage for the Instagram platform adapter in
// src/video/platform-adapters/instagram.ts.
//
// All side-effecting collaborators arrive via `InstagramAdapterDeps`, so the
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
  InstagramAdapter,
  InstagramAdapterError,
  createInstagramAdapter,
  defaultEncryptAndPack,
  defaultGetEncryptionKey,
} from '../../../src/video/platform-adapters/instagram'
import type { InstagramAdapterDeps } from '../../../src/video/platform-adapters/instagram'
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

const TENANT = 'tenant-1'
const KEY = generateEncryptionKey()

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function envFixture(): CrumEnv {
  return {
    NODE_ENV: 'test',
    VIDEO_INSTAGRAM_CLIENT_ID: 'ig-client-id',
    VIDEO_INSTAGRAM_CLIENT_SECRET: 'ig-client-secret',
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
  /** `null` models a token row with no access token stored. */
  accessToken?: string | null
  expiresAt?: string | null
}

function tokenRow(options: RowOptions = {}): OAuthToken {
  return {
    id: options.id ?? 'tok-1',
    tenant_id: TENANT,
    platform: 'instagram',
    access_token_encrypted:
      options.accessToken === null
        ? (null as unknown as string)
        : packToken(options.accessToken ?? 'fresh-access-token'),
    // Instagram Login has NO classic refresh token — rows legitimately store null.
    refresh_token_encrypted: null,
    // Far future ⇒ needsRefresh() is false unless a test wants otherwise.
    expires_at: options.expiresAt ?? '2099-01-01T00:00:00.000Z',
    scope: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

/** One raw Graph media object; overrides mirror the /me/media field shape. */
function igMedia(overrides: Record<string, unknown> = {}) {
  return {
    id: 'media-1',
    timestamp: '2026-01-01T10:00:00+0000',
    video_views: 1000,
    like_count: 50,
    comment_count: 5,
    share_count: 2,
    ...overrides,
  }
}

function mediaBody(items: unknown[], next?: string) {
  return next ? { data: items, paging: { next } } : { data: items }
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
 * Router-style fake fetch: each call picks the first matcher whose predicate
 * accepts the URL and pops the next queued response for that route.
 */
interface Route {
  match: (url: string) => boolean
  responses: Array<{ status: number; body: unknown }>
}

function makeFetch(routes: Route[]) {
  // The parameter describes the recorded call tuple; the body is a plain
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

const isMedia = (url: string) => url.includes('/me/media')
const isRefresh = (url: string) => url.includes('/refresh_access_token')

function mediaQueryAt(fetchImpl: ReturnType<typeof makeFetch>, index = 0): URLSearchParams {
  return new URL(requestUrlOf(vi.mocked(fetchImpl).mock.calls[index]![0])).searchParams
}

function authHeaderAt(fetchImpl: ReturnType<typeof makeFetch>, index = 0): string {
  const headers = vi.mocked(fetchImpl).mock.calls[index]![1]!.headers as Record<string, string | undefined>
  return headers.Authorization ?? ''
}

const epoch = (iso: string) => String(Math.floor(Date.parse(iso) / 1000))

// ---------------------------------------------------------------------------
// Deps factory
// ---------------------------------------------------------------------------

interface DepsOverrides {
  fetch?: typeof fetch
  encryptAndPack?: (plaintext: string, key: Buffer) => string
}

function buildDeps(overrides: DepsOverrides = {}): InstagramAdapterDeps {
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

describe('InstagramAdapter – basics', () => {
  it('reports platform=instagram, audience-only capabilities', () => {
    const adapter = new InstagramAdapter(buildDeps(), TENANT)
    expect(adapter.platform).toBe('instagram')
    // Instagram exposes no revenue dollars in any public API.
    expect(adapter.supportsRevenue).toBe(false)
    expect(adapter.supportsAudienceMetrics).toBe(true)
  })

  it('createInstagramAdapter wires default deps behind the same interface', () => {
    const adapter = createInstagramAdapter(envFixture(), TENANT)
    expect(adapter).toBeInstanceOf(InstagramAdapter)
    expect(adapter.platform).toBe('instagram')
  })

  it('fetchEarnings inherits the base "not implemented" throw without touching DB or network', async () => {
    const fetchImpl = makeFetch([])
    const adapter = new InstagramAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    await expect(adapter.fetchEarnings('ig-account-1', RANGE)).rejects.toThrow(
      /fetchEarnings is not implemented/,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(db.getLatestOAuthToken).not.toHaveBeenCalled()
  })

  it('fetchAudienceMetrics fails with a clear error when the tenant has no token row', async () => {
    db.getLatestOAuthToken.mockResolvedValue(null)
    const adapter = new InstagramAdapter(buildDeps(), TENANT)

    await expect(adapter.fetchAudienceMetrics('ig-account-1', RANGE)).rejects.toThrow(InstagramAdapterError)
    await expect(adapter.fetchAudienceMetrics('ig-account-1', RANGE)).rejects.toThrow(
      /No Instagram OAuth token found/,
    )
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
// fetchAudienceMetrics
// ---------------------------------------------------------------------------

describe('InstagramAdapter.fetchAudienceMetrics', () => {
  beforeEach(() => {
    db.getLatestOAuthToken.mockResolvedValue(tokenRow())
    db.getOAuthTokenById.mockResolvedValue(tokenRow())
  })

  it('queries /me/media for the range and buckets in-range media into per-date summed records', async () => {
    const fetchImpl = makeFetch([
      {
        match: isMedia,
        responses: [
          {
            status: 200,
            body: mediaBody([
              // Two posts on 2026-01-01 → summed into one record.
              igMedia({
                id: 'a',
                timestamp: '2026-01-01T10:00:00+0000',
                video_views: 1000,
                like_count: 50,
                comment_count: 5,
                share_count: 2,
                insights: { data: [{ name: 'engagement', values: [{ value: 57 }] }] },
              }),
              igMedia({
                id: 'b',
                timestamp: '2026-01-01T22:30:00+0000',
                video_views: 250,
                like_count: 10,
                comment_count: 1,
                share_count: 0,
              }),
              // One post on 2026-01-02 (string counter gets coerced client-side).
              igMedia({
                id: 'c',
                timestamp: '2026-01-02T15:00:00+0000',
                video_views: '700',
                like_count: 33,
                comment_count: 7,
                share_count: 4,
              }),
              // Outside the range on both ends → filtered out.
              igMedia({ id: 'too-early', timestamp: '2025-12-31T23:59:00+0000' }),
              igMedia({ id: 'too-late', timestamp: '2026-01-03T10:00:00+0000' }),
              // Unparseable timestamp → skipped defensively.
              igMedia({ id: 'broken', timestamp: 'not-a-timestamp' }),
            ]),
          },
        ],
      },
    ])
    const adapter = new InstagramAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchAudienceMetrics('ig-account-1', { start: '2026-01-01', end: '2026-01-02' })

    // Request shape: default field set (incl. inline insights), epoch since/until.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const q = mediaQueryAt(fetchImpl)
    expect(q.get('fields')).toContain('insights.metric(engagement,impressions,reach)')
    expect(q.get('fields')).toContain('video_views')
    expect(q.get('limit')).toBe('100')
    expect(q.get('since')).toBe(epoch('2026-01-01T00:00:00.000Z'))
    expect(q.get('until')).toBe(epoch('2026-01-02T23:59:59.000Z'))
    expect(authHeaderAt(fetchImpl)).toBe('Bearer fresh-access-token')

    expect(data.channelId).toBe('ig-account-1')
    expect(data.platform).toBe('instagram')
    expect(data.dateRange).toEqual({ start: '2026-01-01', end: '2026-01-02' })
    expect(typeof data.fetchedAt).toBe('string')
    expect(data.records).toEqual([
      {
        date: '2026-01-01',
        views: 1250,
        watchTimeMinutes: 0, // Instagram reports no watch time
        subscribersGained: 0, // no follower-delta metric on this endpoint
        subscribersLost: 0,
        likes: 60,
        comments: 6,
        shares: 2,
      },
      {
        date: '2026-01-02',
        views: 700,
        watchTimeMinutes: 0,
        subscribersGained: 0,
        subscribersLost: 0,
        likes: 33,
        comments: 7,
        shares: 4,
      },
    ])
  })

  it('follows paging.next transparently and buckets across pages', async () => {
    const nextPage = 'https://graph.instagram.com/me/media?fields=id&after=CURSOR'
    const fetchImpl = makeFetch([
      {
        match: isMedia,
        responses: [
          { status: 200, body: mediaBody([igMedia({ id: 'p1', video_views: 10, like_count: 0, comment_count: 0, share_count: 0 })], nextPage) },
          {
            status: 200,
            body: mediaBody([
              igMedia({ id: 'p2', timestamp: '2026-01-01T18:00:00+0000', video_views: 20, like_count: 4, comment_count: 1, share_count: 1 }),
            ]),
          },
        ],
      },
    ])
    const adapter = new InstagramAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchAudienceMetrics('ig-account-1', RANGE)

    expect(vi.mocked(fetchImpl).mock.calls.map((c) => requestUrlOf(c[0]))).toHaveLength(2)
    expect(requestUrlOf(vi.mocked(fetchImpl).mock.calls[1]![0])).toBe(nextPage)
    expect(data.records).toHaveLength(1)
    expect(data.records[0]!.views).toBe(30)
    expect(data.records[0]!.likes).toBe(4)
  })

  it('returns an empty records array when no media exists in the range', async () => {
    const fetchImpl = makeFetch([{ match: isMedia, responses: [{ status: 200, body: mediaBody([]) }] }])
    const adapter = new InstagramAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchAudienceMetrics('ig-account-1', RANGE)

    expect(data.records).toEqual([])
    expect(data.platform).toBe('instagram')
  })

  it('surfaces Meta failures that are not 401s (e.g. 429 rate limits) without retrying', async () => {
    const fetchImpl = makeFetch([
      {
        match: isMedia,
        responses: [
          {
            status: 429,
            body: { error: { message: 'Call limit reached', type: 'APICallRateException', code: 4, fbtrace_id: 'X' } },
          },
        ],
      },
    ])
    const adapter = new InstagramAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    await expect(adapter.fetchAudienceMetrics('ig-account-1', RANGE)).rejects.toThrow(/Call limit reached/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// refreshOAuthToken
// ---------------------------------------------------------------------------

describe('InstagramAdapter.refreshOAuthToken', () => {
  it('decrypts the stored ACCESS token for real, calls refresh_access_token, and writes back the rotated token', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'))

    db.getOAuthTokenById.mockResolvedValue(tokenRow({ accessToken: 'stored-ig-access' }))
    const encryptAndPack = vi.fn((plaintext: string) => `PACKED(${plaintext})`)
    const fetchImpl = makeFetch([
      {
        match: isRefresh,
        // 60-day long-lived rotation.
        responses: [{ status: 200, body: { access_token: 'brand-new-token', expires_in: 5184000 } }],
      },
    ])
    const adapter = new InstagramAdapter(buildDeps({ fetch: fetchImpl, encryptAndPack }), TENANT)

    await adapter.refreshOAuthToken('tok-1')

    // Instagram Login has NO refresh_token: the credential rotated is the
    // stored ACCESS token itself, decrypted for real from the row.
    const url = new URL(requestUrlOf(vi.mocked(fetchImpl).mock.calls[0]![0]))
    expect(url.origin + url.pathname).toBe('https://graph.instagram.com/refresh_access_token')
    expect(url.searchParams.get('grant_type')).toBe('ig_refresh_token')
    expect(url.searchParams.get('access_token')).toBe('stored-ig-access')
    expect(url.searchParams.get('client_id')).toBe('ig-client-id')
    expect(url.searchParams.get('client_secret')).toBe('ig-client-secret')

    // Re-encryption ran through the injected fake, with the decrypted key.
    expect(encryptAndPack).toHaveBeenCalledWith('brand-new-token', KEY)

    // Exact write-back: tenant + token row + packed new access token + expiry.
    expect(db.updateOAuthToken).toHaveBeenCalledWith(TENANT, 'tok-1', {
      accessTokenEnc: 'PACKED(brand-new-token)',
      expiresAt: '2026-07-31T12:00:00.000Z',
    })
    // Refresh is row-scoped: the "latest token" lookup must not be consulted.
    expect(db.getLatestOAuthToken).not.toHaveBeenCalled()
  })

  it('throws a clear InstagramAdapterError when the row has no stored access token', async () => {
    db.getOAuthTokenById.mockResolvedValue(tokenRow({ accessToken: null }))
    const fetchImpl = makeFetch([])
    const adapter = new InstagramAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    await expect(adapter.refreshOAuthToken('tok-1')).rejects.toThrow(InstagramAdapterError)
    await expect(adapter.refreshOAuthToken('tok-1')).rejects.toThrow(/must be re-connected/)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(db.updateOAuthToken).not.toHaveBeenCalled()
  })

  it('throws when the token row is missing for the tenant', async () => {
    db.getOAuthTokenById.mockResolvedValue(null)
    const adapter = new InstagramAdapter(buildDeps(), TENANT)

    await expect(adapter.refreshOAuthToken('tok-404')).rejects.toThrow(/not found for tenant/)
  })

  it('fails fast when the Instagram app credentials are not configured', async () => {
    db.getOAuthTokenById.mockResolvedValue(tokenRow())
    const deps = buildDeps()
    deps.env = { NODE_ENV: 'test' } as unknown as CrumEnv
    const adapter = new InstagramAdapter(deps, TENANT)

    await expect(adapter.refreshOAuthToken('tok-1')).rejects.toThrow(/VIDEO_INSTAGRAM_CLIENT_ID/)
  })
})

// ---------------------------------------------------------------------------
// 401 recovery: refresh once, then retry
// ---------------------------------------------------------------------------

describe('InstagramAdapter 401 refresh-and-retry', () => {
  it('refreshes the access token on a 401 and retries the media query exactly once', async () => {
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
        match: isMedia,
        responses: [
          {
            status: 401,
            body: {
              error: {
                message: 'Error validating access token: The session has been invalidated.',
                type: 'OAuthException',
                code: 190,
                fbtrace_id: 'Y',
              },
            },
          },
          {
            status: 200,
            body: mediaBody([igMedia({ id: 'after-retry', video_views: 80, like_count: 6, comment_count: 2, share_count: 1 })]),
          },
        ],
      },
      {
        match: isRefresh,
        responses: [{ status: 200, body: { access_token: 'rotated-access', expires_in: 3600 } }],
      },
    ])
    const adapter = new InstagramAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchAudienceMetrics('ig-account-1', RANGE)

    // Order: media(401) → token refresh → media(retry). One retry only.
    const urls = vi.mocked(fetchImpl).mock.calls.map((c) => requestUrlOf(c[0]))
    expect(urls).toHaveLength(3)
    expect(isMedia(urls[0]!)).toBe(true)
    expect(isRefresh(urls[1]!)).toBe(true)
    expect(isMedia(urls[2]!)).toBe(true)

    // The retry authenticates with the rotated access token (written back by
    // the refresh flow and re-read from the mocked row), not the stale one.
    expect(authHeaderAt(fetchImpl, 0)).toBe('Bearer stale-access-token')
    expect(authHeaderAt(fetchImpl, 2)).toBe('Bearer rotated-access')

    expect(db.updateOAuthToken).toHaveBeenCalledTimes(1)
    expect(data.records).toHaveLength(1)
    expect(data.records[0]).toEqual({
      date: '2026-01-01',
      views: 80,
      watchTimeMinutes: 0,
      subscribersGained: 0,
      subscribersLost: 0,
      likes: 6,
      comments: 2,
      shares: 1,
    })
  })
})
