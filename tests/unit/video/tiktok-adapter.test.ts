// tests/unit/video/tiktok-adapter.test.ts
// Unit coverage for the TikTok (audience-only) platform adapter in
// src/video/platform-adapters/tiktok.ts.
//
// All side-effecting collaborators arrive via `TiktokAdapterDeps`, so the
// adapter runs with faked DB readers/writers, a faked transport, and REAL
// AES-GCM helpers from src/video/oauth-encryption.ts: fixtures pack genuine
// ciphertext, and the adapter's unpackEncrypted/decryptToken path runs
// end-to-end rather than being stubbed.
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
  TiktokAdapter,
  TiktokAdapterError,
  TiktokChannelClient,
  createTiktokAdapter,
  defaultEncryptAndPack,
  defaultGetEncryptionKey,
} from '../../../src/video/platform-adapters/tiktok'
import type { TiktokAdapterDeps } from '../../../src/video/platform-adapters/tiktok'
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

const VIDEO_QUERY_URL = 'https://open.tiktokapis.com/v2/video/query'
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token'
const TENANT = 'tenant-1'
const KEY = generateEncryptionKey()

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function envFixture(): CrumEnv {
  return {
    NODE_ENV: 'test',
    // TikTok calls the OAuth client id `client_key`.
    VIDEO_TIKTOK_CLIENT_ID: 'client-key',
    VIDEO_TIKTOK_CLIENT_SECRET: 'client-secret',
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
    platform: 'tiktok',
    access_token_encrypted: packToken(options.accessToken ?? 'fresh-access-token'),
    refresh_token_encrypted:
      options.refreshToken === null ? null : packToken(options.refreshToken ?? 'stored-refresh-token'),
    // Far future ⇒ needsRefresh() is false unless a test wants otherwise.
    expires_at: options.expiresAt ?? '2099-01-01T00:00:00.000Z',
    scope: 'user.info.basic,video.list',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  }
}

function stubResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

// A single video-query page in the exact Display API v2 envelope shape.
function videoPage(videos: Array<{ id: string; stats: Record<string, number> }>, cursor: number, hasMore: boolean) {
  return { data: { videos, cursor, has_more: hasMore } }
}

interface Route {
  match: (url: string) => boolean
  responses: Array<{ status: number; body: unknown }>
}

function makeFetch(routes: Route[]) {
  const fetchFn = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    for (const route of routes) {
      if (route.match(url)) {
        const next = route.responses.shift()
        if (!next) throw new Error(`fake fetch: route exhausted for ${url}`)
        return stubResponse(next.status, next.body)
      }
    }
    throw new Error(`fake fetch: unexpected URL ${url}`)
  })
  return fetchFn as unknown as typeof fetch
}

const isVideoQuery = (url: string) => url.startsWith(VIDEO_QUERY_URL)
const isToken = (url: string) => url.startsWith(TOKEN_URL)

function urlAt(fetchImpl: ReturnType<typeof makeFetch>, index = 0): string {
  return String(vi.mocked(fetchImpl).mock.calls[index]![0])
}
function initAt(fetchImpl: ReturnType<typeof makeFetch>, index = 0): RequestInit {
  return vi.mocked(fetchImpl).mock.calls[index]![1] as RequestInit
}
function authHeaderAt(fetchImpl: ReturnType<typeof makeFetch>, index = 0): string {
  const headers = initAt(fetchImpl, index).headers as Record<string, string | undefined>
  return headers.Authorization ?? ''
}
function jsonBodyAt(fetchImpl: ReturnType<typeof makeFetch>, index = 0): Record<string, unknown> {
  return JSON.parse(String(initAt(fetchImpl, index).body)) as Record<string, unknown>
}
function formAt(fetchImpl: ReturnType<typeof makeFetch>, index = 0): URLSearchParams {
  return new URLSearchParams(String(initAt(fetchImpl, index).body))
}

// ---------------------------------------------------------------------------
// Deps factory
// ---------------------------------------------------------------------------

interface DepsOverrides {
  fetch?: typeof fetch
  encryptAndPack?: (plaintext: string, key: Buffer) => string
  env?: CrumEnv
}

function buildDeps(overrides: DepsOverrides = {}): TiktokAdapterDeps {
  return {
    env: overrides.env ?? envFixture(),
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

const RANGE: DateRange = { start: '2026-01-01', end: '2026-01-07' }

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TiktokAdapter – basics', () => {
  it('reports platform=tiktok', () => {
    expect(new TiktokAdapter(buildDeps(), TENANT).platform).toBe('tiktok')
  })

  it('overrides supportsRevenue to false but keeps audience metrics enabled', () => {
    const adapter = new TiktokAdapter(buildDeps(), TENANT)
    expect(adapter.supportsRevenue).toBe(false)
    expect(adapter.supportsAudienceMetrics).toBe(true)
  })

  it('createTiktokAdapter wires default deps behind the same interface', () => {
    const adapter = createTiktokAdapter(envFixture(), TENANT)
    expect(adapter).toBeInstanceOf(TiktokAdapter)
    expect(adapter.platform).toBe('tiktok')
    expect(adapter.supportsRevenue).toBe(false)
  })

  it('fetchEarnings inherits the base "not implemented" throw', async () => {
    const adapter = new TiktokAdapter(buildDeps(), TENANT)
    await expect(adapter.fetchEarnings('tt-account', RANGE)).rejects.toThrow(/fetchEarnings is not implemented/)
    await expect(adapter.fetchEarnings('tt-account', RANGE)).rejects.toThrow(/\[tiktok\]/)
  })

  it('fetchAudienceMetrics fails with a clear error when the tenant has no token row', async () => {
    db.getLatestOAuthToken.mockResolvedValue(null)
    const adapter = new TiktokAdapter(buildDeps(), TENANT)

    await expect(adapter.fetchAudienceMetrics('tt-account', RANGE)).rejects.toThrow(TiktokAdapterError)
    await expect(adapter.fetchAudienceMetrics('tt-account', RANGE)).rejects.toThrow(/No TikTok OAuth token found/)
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
// fetchAudienceMetrics — single summary row
// ---------------------------------------------------------------------------

describe('TiktokAdapter.fetchAudienceMetrics', () => {
  beforeEach(() => {
    db.getLatestOAuthToken.mockResolvedValue(tokenRow())
    db.getOAuthTokenById.mockResolvedValue(tokenRow())
  })

  it('aggregates every video across pages into ONE summary row at dateRange.start', async () => {
    const fetchImpl = makeFetch([
      {
        match: isVideoQuery,
        responses: [
          {
            status: 200,
            body: videoPage(
              [{ id: 'v1', stats: { play_count: 1000, digg_count: 50, comment_count: 12, share_count: 3 } }],
              20,
              true,
            ),
          },
          {
            status: 200,
            body: videoPage(
              [{ id: 'v2', stats: { play_count: 500, digg_count: 25, comment_count: 8, share_count: 1 } }],
              40,
              false,
            ),
          },
        ],
      },
    ])
    const adapter = new TiktokAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchAudienceMetrics('tt-account', RANGE)

    expect(data.channelId).toBe('tt-account')
    expect(data.platform).toBe('tiktok')
    expect(data.dateRange).toEqual(RANGE)
    expect(typeof data.fetchedAt).toBe('string')

    // TikTok exposes no daily series → exactly one collapsed summary record.
    expect(data.records).toHaveLength(1)
    expect(data.records[0]).toEqual({
      date: '2026-01-01',
      views: 1500,
      // Watch time / follower deltas are structurally unavailable in the
      // Display API, so they are legitimately zero.
      watchTimeMinutes: 0,
      subscribersGained: 0,
      subscribersLost: 0,
      likes: 75,
      comments: 20,
      shares: 4,
    })

    // Pagination: page 1 has no after_cursor; page 2 threads the prior cursor.
    expect(jsonBodyAt(fetchImpl, 0).after_cursor).toBeUndefined()
    expect(jsonBodyAt(fetchImpl, 0)).toMatchObject({ filters: { deleted_video: false }, max_results: 20 })
    expect(jsonBodyAt(fetchImpl, 1).after_cursor).toBe(20)

    // Real decrypt happened: the Bearer header carries the plaintext access token.
    expect(authHeaderAt(fetchImpl, 0)).toBe('Bearer fresh-access-token')
    expect(authHeaderAt(fetchImpl, 1)).toBe('Bearer fresh-access-token')
  })

  it('returns a single zeroed summary row when the account has no videos', async () => {
    const fetchImpl = makeFetch([
      { match: isVideoQuery, responses: [{ status: 200, body: videoPage([], 0, false) }] },
    ])
    const adapter = new TiktokAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchAudienceMetrics('tt-account', RANGE)

    expect(data.records).toHaveLength(1)
    expect(data.records[0]).toEqual({
      date: '2026-01-01',
      views: 0,
      watchTimeMinutes: 0,
      subscribersGained: 0,
      subscribersLost: 0,
      likes: 0,
      comments: 0,
      shares: 0,
    })
  })

  it('stops cleanly and reports zeros when the API answers with an empty envelope', async () => {
    const fetchImpl = makeFetch([{ match: isVideoQuery, responses: [{ status: 200, body: {} }] }])
    const adapter = new TiktokAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchAudienceMetrics('tt-account', RANGE)
    expect(data.records[0]!.views).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 401 recovery: refresh once, then restart pagination
// ---------------------------------------------------------------------------

describe('TiktokAdapter.fetchAudienceMetrics 401 refresh-and-retry', () => {
  it('refreshes the token on a 401 and retries the video query exactly once', async () => {
    db.getLatestOAuthToken.mockResolvedValue(tokenRow({ accessToken: 'stale-access-token' }))
    const staleRow = tokenRow({ accessToken: 'stale-access-token' })
    const rotatedRow = tokenRow({ accessToken: 'rotated-access' })
    // Loads: pre-query check; inside refreshTokenRow; post-refresh reload.
    db.getOAuthTokenById
      .mockResolvedValueOnce(staleRow)
      .mockResolvedValueOnce(staleRow)
      .mockResolvedValueOnce(rotatedRow)

    const fetchImpl = makeFetch([
      {
        match: isVideoQuery,
        responses: [
          { status: 401, body: { error: { code: 'error_access_token_wrong', message: 'invalid token' } } },
          { status: 200, body: videoPage([{ id: 'v1', stats: { play_count: 7, digg_count: 1, comment_count: 0, share_count: 0 } }], 0, false) },
        ],
      },
      {
        match: isToken,
        responses: [{ status: 200, body: { access_token: 'rotated-access', expires_in: 3600 } }],
      },
    ])
    const adapter = new TiktokAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchAudienceMetrics('tt-account', RANGE)

    // Order: video-query(401) → token refresh → video-query(retry). One retry.
    expect(isVideoQuery(urlAt(fetchImpl, 0))).toBe(true)
    expect(isToken(urlAt(fetchImpl, 1))).toBe(true)
    expect(isVideoQuery(urlAt(fetchImpl, 2))).toBe(true)

    expect(authHeaderAt(fetchImpl, 0)).toBe('Bearer stale-access-token')
    expect(authHeaderAt(fetchImpl, 2)).toBe('Bearer rotated-access')

    expect(db.updateOAuthToken).toHaveBeenCalledTimes(1)
    expect(data.records[0]!.views).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// refreshOAuthToken
// ---------------------------------------------------------------------------

describe('TiktokAdapter.refreshOAuthToken', () => {
  it('decrypts the stored refresh token, rotates the access AND refresh token, and writes both back', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'))

    db.getOAuthTokenById.mockResolvedValue(tokenRow({ refreshToken: 'stored-refresh-token' }))
    const encryptAndPack = vi.fn((plaintext: string) => `PACKED(${plaintext})`)
    const fetchImpl = makeFetch([
      {
        match: isToken,
        responses: [
          {
            status: 200,
            body: { access_token: 'brand-new-token', expires_in: 3600, refresh_token: 'rotated-refresh' },
          },
        ],
      },
    ])
    const adapter = new TiktokAdapter(buildDeps({ fetch: fetchImpl, encryptAndPack }), TENANT)

    await adapter.refreshOAuthToken('tok-1')

    // Real decrypt: the form body carries the plaintext refresh token + client_key.
    const form = formAt(fetchImpl, 0)
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('client_key')).toBe('client-key')
    expect(form.get('client_secret')).toBe('client-secret')
    expect(form.get('refresh_token')).toBe('stored-refresh-token')

    // Both tokens re-encrypted through the injected fake, with the decrypted key.
    expect(encryptAndPack).toHaveBeenCalledWith('brand-new-token', KEY)
    expect(encryptAndPack).toHaveBeenCalledWith('rotated-refresh', KEY)

    // Exact write-back: access + ROTATED refresh + expiry.
    expect(db.updateOAuthToken).toHaveBeenCalledWith(TENANT, 'tok-1', {
      accessTokenEnc: 'PACKED(brand-new-token)',
      refreshTokenEnc: 'PACKED(rotated-refresh)',
      expiresAt: '2026-06-01T13:00:00.000Z',
    })
    // Refresh is row-scoped: the "latest token" lookup must not be consulted.
    expect(db.getLatestOAuthToken).not.toHaveBeenCalled()
  })

  it('writes only the access token when TikTok does NOT rotate the refresh token', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'))

    db.getOAuthTokenById.mockResolvedValue(tokenRow({ refreshToken: 'stored-refresh-token' }))
    const fetchImpl = makeFetch([
      { match: isToken, responses: [{ status: 200, body: { access_token: 'brand-new-token', expires_in: 3600 } }] },
    ])
    const adapter = new TiktokAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    await adapter.refreshOAuthToken('tok-1')

    // No `refreshTokenEnc` key at all when nothing rotated.
    expect(db.updateOAuthToken).toHaveBeenCalledWith(TENANT, 'tok-1', {
      accessTokenEnc: 'PACKED(brand-new-token)',
      expiresAt: '2026-06-01T13:00:00.000Z',
    })
  })

  it('throws a clear TiktokAdapterError when the row has no stored refresh token', async () => {
    db.getOAuthTokenById.mockResolvedValue(tokenRow({ refreshToken: null }))
    const fetchImpl = makeFetch([])
    const adapter = new TiktokAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    await expect(adapter.refreshOAuthToken('tok-1')).rejects.toThrow(TiktokAdapterError)
    await expect(adapter.refreshOAuthToken('tok-1')).rejects.toThrow(/must be re-connected/)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(db.updateOAuthToken).not.toHaveBeenCalled()
  })

  it('throws when the token row is missing for the tenant', async () => {
    db.getOAuthTokenById.mockResolvedValue(null)
    const adapter = new TiktokAdapter(buildDeps(), TENANT)

    await expect(adapter.refreshOAuthToken('tok-404')).rejects.toThrow(/not found for tenant/)
  })

  it('fails fast when the OAuth client credentials are not configured', async () => {
    db.getOAuthTokenById.mockResolvedValue(tokenRow())
    const deps = buildDeps({ env: { NODE_ENV: 'test' } as unknown as CrumEnv })
    const adapter = new TiktokAdapter(deps, TENANT)

    await expect(adapter.refreshOAuthToken('tok-1')).rejects.toThrow(/VIDEO_TIKTOK_CLIENT_ID/)
  })
})

// ---------------------------------------------------------------------------
// withChannel – bound client
// ---------------------------------------------------------------------------

describe('TiktokAdapter.withChannel', () => {
  it('binds an explicit token row, resolves it by id (never latest), and scopes to the bound account', async () => {
    db.getOAuthTokenById.mockResolvedValue(tokenRow({ id: 'tok-explicit', accessToken: 'bound-access' }))
    const fetchImpl = makeFetch([
      {
        match: isVideoQuery,
        responses: [
          {
            status: 200,
            body: videoPage([{ id: 'v1', stats: { play_count: 42, digg_count: 4, comment_count: 2, share_count: 1 } }], 0, false),
          },
        ],
      },
    ])
    const adapter = new TiktokAdapter(buildDeps({ fetch: fetchImpl }), TENANT)
    const client = adapter.withChannel(TENANT, 'tok-explicit', 'tt-bound')

    expect(client).toBeInstanceOf(TiktokChannelClient)

    const data = await client.fetchAudienceMetrics(RANGE)

    expect(db.getLatestOAuthToken).not.toHaveBeenCalled()
    expect(db.getOAuthTokenById).toHaveBeenCalledWith(TENANT, 'tok-explicit')
    expect(data.channelId).toBe('tt-bound')
    expect(authHeaderAt(fetchImpl)).toBe('Bearer bound-access')
    expect(data.records).toHaveLength(1)
    expect(data.records[0]!.views).toBe(42)
  })

  it('exposes refreshOAuthToken against the bound token row', async () => {
    db.getOAuthTokenById.mockResolvedValue(tokenRow({ id: 'tok-explicit' }))
    const fetchImpl = makeFetch([
      { match: isToken, responses: [{ status: 200, body: { access_token: 'x', expires_in: 10 } }] },
    ])
    const adapter = new TiktokAdapter(buildDeps({ fetch: fetchImpl }), TENANT)
    const client = adapter.withChannel(TENANT, 'tok-explicit', 'tt-bound')

    await client.refreshOAuthToken()

    expect(db.getOAuthTokenById).toHaveBeenCalledWith(TENANT, 'tok-explicit')
    expect(db.updateOAuthToken).toHaveBeenCalledWith(TENANT, 'tok-explicit', expect.objectContaining({
      accessTokenEnc: 'PACKED(x)',
    }))
  })
})
