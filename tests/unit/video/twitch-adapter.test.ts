// tests/unit/video/twitch-adapter.test.ts
// Unit coverage for the Twitch platform adapter in
// src/video/platform-adapters/twitch.ts.
//
// All side-effecting collaborators arrive via `TwitchAdapterDeps`, so the
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
  TwitchAdapter,
  TwitchAdapterError,
  createTwitchAdapter,
  defaultEncryptAndPack,
  defaultGetEncryptionKey,
} from '../../../src/video/platform-adapters/twitch'
import type { TwitchAdapterDeps } from '../../../src/video/platform-adapters/twitch'
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

const HELIX_BASE = 'https://api.twitch.tv/helix'
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const TENANT = 'tenant-1'
const KEY = generateEncryptionKey()

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function envFixture(): CrumEnv {
  return {
    NODE_ENV: 'test',
    VIDEO_TWITCH_CLIENT_ID: 'client-id',
    VIDEO_TWITCH_CLIENT_SECRET: 'client-secret',
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
    platform: 'twitch',
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

function stubResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response
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
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
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

const isFollowers = (url: string) => url.startsWith(`${HELIX_BASE}/channels/followers`)
const isStreams = (url: string) => url.startsWith(`${HELIX_BASE}/streams`)
const isToken = (url: string) => url.startsWith(TOKEN_URL)

/** All recorded fetch calls whose URL matches the route predicate. */
function callsMatching(fetchImpl: ReturnType<typeof makeFetch>, match: (url: string) => boolean) {
  return vi.mocked(fetchImpl).mock.calls.filter((c) => match(String(c[0])))
}

function queryAt(
  fetchImpl: ReturnType<typeof makeFetch>,
  match: (url: string) => boolean,
  index = 0,
): URLSearchParams {
  const call = callsMatching(fetchImpl, match)[index]
  return new URL(String(call![0])).searchParams
}

function headersAt(
  fetchImpl: ReturnType<typeof makeFetch>,
  match: (url: string) => boolean,
  index = 0,
): Record<string, string> {
  const call = callsMatching(fetchImpl, match)[index]
  return (call![1] as RequestInit).headers as Record<string, string>
}

// ---------------------------------------------------------------------------
// Deps factory
// ---------------------------------------------------------------------------

interface DepsOverrides {
  fetch?: typeof fetch
  encryptAndPack?: (plaintext: string, key: Buffer) => string
}

function buildDeps(overrides: DepsOverrides = {}): TwitchAdapterDeps {
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

const liveStreamBody = (viewerCount: number) => ({
  data: [
    {
      id: '4242',
      user_id: '141991764',
      user_name: 'cod3r',
      game_name: 'Just Chatting',
      title: 'building CRUM live',
      viewer_count: viewerCount,
    },
  ],
  pagination: {},
})

// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TwitchAdapter – basics', () => {
  it('reports platform=twitch', () => {
    expect(new TwitchAdapter(buildDeps(), TENANT).platform).toBe('twitch')
  })

  it('is AUDIENCE-ONLY: supportsRevenue=false while supportsAudienceMetrics stays true', () => {
    const adapter = new TwitchAdapter(buildDeps(), TENANT)
    // Twitch exposes no revenue dollars in Helix — payouts are private
    // creator-dashboard data. The earnings sync must skip this adapter.
    expect(adapter.supportsRevenue).toBe(false)
    expect(adapter.supportsAudienceMetrics).toBe(true)
  })

  it('createTwitchAdapter wires default deps behind the same interface', () => {
    const adapter = createTwitchAdapter(envFixture(), TENANT)
    expect(adapter).toBeInstanceOf(TwitchAdapter)
    expect(adapter.platform).toBe('twitch')
    expect(adapter.supportsRevenue).toBe(false)
  })

  it('fetchEarnings is NOT implemented: inherits the BasePlatformAdapter throw without touching the DB', async () => {
    const adapter = new TwitchAdapter(buildDeps(), TENANT)

    await expect(adapter.fetchEarnings('141991764', RANGE)).rejects.toThrow(Error)
    await expect(adapter.fetchEarnings('141991764', RANGE)).rejects.toThrow(
      '[twitch] fetchEarnings is not implemented',
    )
    expect(db.getLatestOAuthToken).not.toHaveBeenCalled()
    expect(db.getOAuthTokenById).not.toHaveBeenCalled()
  })

  it('fetchAudienceMetrics fails with a clear error when the tenant has no token row', async () => {
    db.getLatestOAuthToken.mockResolvedValue(null)
    const adapter = new TwitchAdapter(buildDeps(), TENANT)

    await expect(adapter.fetchAudienceMetrics('141991764', RANGE)).rejects.toThrow(TwitchAdapterError)
    await expect(adapter.fetchAudienceMetrics('141991764', RANGE)).rejects.toThrow(/No Twitch OAuth token found/)
  })

  it('fetchAudienceMetrics fails fast when VIDEO_TWITCH_CLIENT_ID is not configured', async () => {
    const deps = buildDeps()
    // Every Helix request needs the Client-Id header; no DB/network touched.
    deps.env = { NODE_ENV: 'test', OAUTH_ENCRYPTION_KEY: KEY.toString('hex') } as unknown as CrumEnv
    const adapter = new TwitchAdapter(deps, TENANT)

    await expect(adapter.fetchAudienceMetrics('141991764', RANGE)).rejects.toThrow(/VIDEO_TWITCH_CLIENT_ID/)
    expect(db.getLatestOAuthToken).not.toHaveBeenCalled()
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
// fetchAudienceMetrics — sparse best-effort summary row
// ---------------------------------------------------------------------------

describe('TwitchAdapter.fetchAudienceMetrics', () => {
  beforeEach(() => {
    db.getLatestOAuthToken.mockResolvedValue(tokenRow())
    db.getOAuthTokenById.mockResolvedValue(tokenRow())
  })

  it('builds ONE summary row dated dateRange.start from followers total + live viewer_count', async () => {
    const fetchImpl = makeFetch([
      { match: isFollowers, responses: [{ status: 200, body: { total: 4200, pagination: {} } }] },
      { match: isStreams, responses: [{ status: 200, body: liveStreamBody(137) }] },
    ])
    const adapter = new TwitchAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchAudienceMetrics('141991764', { start: '2026-01-01', end: '2026-01-07' })

    // Token resolution is tenant+platform scoped via the injected queries.
    expect(db.getLatestOAuthToken).toHaveBeenCalledWith(TENANT, 'twitch')

    // Request shape: Helix query params plus the mandatory Client-Id header on
    // EVERY Helix call (a Bearer token alone is not enough).
    expect(queryAt(fetchImpl, isFollowers).get('broadcaster_id')).toBe('141991764')
    expect(queryAt(fetchImpl, isStreams).get('user_id')).toBe('141991764')
    for (const match of [isFollowers, isStreams]) {
      expect(headersAt(fetchImpl, match).Authorization).toBe('Bearer fresh-access-token')
      expect(headersAt(fetchImpl, match)['Client-Id']).toBe('client-id')
    }

    expect(data.channelId).toBe('141991764')
    expect(data.platform).toBe('twitch')
    expect(data.dateRange).toEqual({ start: '2026-01-01', end: '2026-01-07' })
    expect(data.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(data.records).toHaveLength(1)
    // One summary row: views = live viewer_count snapshot, follower deltas and
    // every Extension-only metric honestly zeroed, total followers attached
    // as the `_followersTotal` extra field (AudienceRecord has no total slot).
    expect(data.records[0]).toEqual({
      date: '2026-01-01',
      views: 137,
      watchTimeMinutes: 0,
      subscribersGained: 0,
      subscribersLost: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      _followersTotal: 4200,
    })
  })

  it('reports views=0 when the channel is offline (/streams answers data: [])', async () => {
    const fetchImpl = makeFetch([
      { match: isFollowers, responses: [{ status: 200, body: { total: 4200 } }] },
      { match: isStreams, responses: [{ status: 200, body: { data: [], pagination: {} } }] },
    ])
    const adapter = new TwitchAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchAudienceMetrics('141991764', RANGE)

    expect(data.records).toHaveLength(1)
    expect(data.records[0]!.views).toBe(0)
    expect(data.records[0]).toHaveProperty('_followersTotal', 4200)
  })

  it('keeps the summary row when the followers endpoint fails, logging a warning and omitting _followersTotal', async () => {
    const fetchImpl = makeFetch([
      {
        match: isFollowers,
        responses: [{ status: 500, body: { error: 'Internal Server Error', status: 500, message: 'boom' } }],
      },
      { match: isStreams, responses: [{ status: 200, body: liveStreamBody(99) }] },
    ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapter = new TwitchAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchAudienceMetrics('141991764', RANGE)

    expect(data.records).toHaveLength(1)
    expect(data.records[0]!.views).toBe(99)
    // A failed follower fetch must NOT be persisted as "0 followers" — the
    // extra field is only present when the value is actually known.
    expect(data.records[0]).not.toHaveProperty('_followersTotal')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('follower total unavailable'))
    warnSpy.mockRestore()
  })

  it('keeps the summary row when the streams endpoint fails, logging a warning and reporting views=0', async () => {
    const fetchImpl = makeFetch([
      { match: isFollowers, responses: [{ status: 200, body: { total: 1000 } }] },
      {
        match: isStreams,
        responses: [{ status: 503, body: { error: 'Service Unavailable', status: 503, message: 'down' } }],
      },
    ])
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const adapter = new TwitchAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchAudienceMetrics('141991764', RANGE)

    expect(data.records).toHaveLength(1)
    expect(data.records[0]!.views).toBe(0)
    expect(data.records[0]).toHaveProperty('_followersTotal', 1000)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('live viewer count unavailable'))
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// refreshOAuthToken — Twitch rotates the refresh token too
// ---------------------------------------------------------------------------

describe('TwitchAdapter.refreshOAuthToken', () => {
  it('decrypts the stored refresh token for real, calls id.twitch.tv, and writes back the new access AND rotated refresh tokens', async () => {
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
    const adapter = new TwitchAdapter(buildDeps({ fetch: fetchImpl, encryptAndPack }), TENANT)

    await adapter.refreshOAuthToken('tok-1')

    // Token endpoint is on id.twitch.tv (different host from Helix) and takes
    // its credentials in the url-encoded body, not a Client-Id header.
    expect(String(vi.mocked(fetchImpl).mock.calls[0]![0])).toBe(TOKEN_URL)

    // Real decrypt happened: the form body carries the plaintext refresh token.
    const init = vi.mocked(fetchImpl).mock.calls[0]![1]!
    expect(String(init.body)).toBeTruthy()
    const form = new URLSearchParams(String(init.body))
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('client_id')).toBe('client-id')
    expect(form.get('client_secret')).toBe('client-secret')
    expect(form.get('refresh_token')).toBe('stored-refresh-token')

    // BOTH rotated tokens re-encrypted through the injected fake, with the decrypted key.
    expect(encryptAndPack).toHaveBeenCalledWith('brand-new-token', KEY)
    expect(encryptAndPack).toHaveBeenCalledWith('rotated-refresh', KEY)

    // Exact write-back: Twitch rotates the refresh token, so the row must
    // carry refreshTokenEnc (updateOAuthToken accepts it) alongside the
    // access token + expiry.
    expect(db.updateOAuthToken).toHaveBeenCalledWith(TENANT, 'tok-1', {
      accessTokenEnc: 'PACKED(brand-new-token)',
      refreshTokenEnc: 'PACKED(rotated-refresh)',
      expiresAt: '2026-06-01T13:00:00.000Z',
    })
    // Refresh is row-scoped: the "latest token" lookup must not be consulted.
    expect(db.getLatestOAuthToken).not.toHaveBeenCalled()
  })

  it('persists only the access token when the response does not rotate the refresh token', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'))

    db.getOAuthTokenById.mockResolvedValue(tokenRow())
    const fetchImpl = makeFetch([
      { match: isToken, responses: [{ status: 200, body: { access_token: 'new-access', expires_in: 14400 } }] },
    ])
    const adapter = new TwitchAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    await adapter.refreshOAuthToken('tok-1')

    expect(db.updateOAuthToken).toHaveBeenCalledWith(TENANT, 'tok-1', {
      accessTokenEnc: 'PACKED(new-access)',
      expiresAt: '2026-06-01T16:00:00.000Z',
    })
    // refreshTokenEnc must be absent (undefined would overwrite with NULL
    // semantics in some writers) when no rotation happened.
    const updates = db.updateOAuthToken.mock.calls[0]![2]
    expect(updates).not.toHaveProperty('refreshTokenEnc')
  })

  it('throws a clear TwitchAdapterError when the row has no stored refresh token', async () => {
    db.getOAuthTokenById.mockResolvedValue(tokenRow({ refreshToken: null }))
    const fetchImpl = makeFetch([])
    const adapter = new TwitchAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    await expect(adapter.refreshOAuthToken('tok-1')).rejects.toThrow(TwitchAdapterError)
    await expect(adapter.refreshOAuthToken('tok-1')).rejects.toThrow(/must be re-connected/)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(db.updateOAuthToken).not.toHaveBeenCalled()
  })

  it('throws when the token row is missing for the tenant', async () => {
    db.getOAuthTokenById.mockResolvedValue(null)
    const adapter = new TwitchAdapter(buildDeps(), TENANT)

    await expect(adapter.refreshOAuthToken('tok-404')).rejects.toThrow(/not found for tenant/)
  })

  it('fails fast when the OAuth client credentials are not configured', async () => {
    db.getOAuthTokenById.mockResolvedValue(tokenRow())
    const deps = buildDeps()
    deps.env = { NODE_ENV: 'test', OAUTH_ENCRYPTION_KEY: KEY.toString('hex') } as unknown as CrumEnv
    const adapter = new TwitchAdapter(deps, TENANT)

    await expect(adapter.refreshOAuthToken('tok-1')).rejects.toThrow(/VIDEO_TWITCH_CLIENT_ID/)
    expect(db.updateOAuthToken).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 401 recovery: refresh once, then retry
// ---------------------------------------------------------------------------

describe('TwitchAdapter 401 refresh-and-retry', () => {
  it('refreshes the token on a 401 and retries the Helix call exactly once', async () => {
    db.getLatestOAuthToken.mockResolvedValue(tokenRow({ accessToken: 'stale-access-token' }))
    const staleRow = tokenRow({ accessToken: 'stale-access-token' })
    const rotatedRow = tokenRow({ accessToken: 'rotated-access' })
    // Loads: 1st pre-query check; 2nd inside refreshTokenRow; 3rd post-refresh
    // reload; 4th for the subsequent /streams call (already fresh).
    db.getOAuthTokenById
      .mockResolvedValueOnce(staleRow)
      .mockResolvedValueOnce(staleRow)
      .mockResolvedValueOnce(rotatedRow)
      .mockResolvedValue(rotatedRow)

    const fetchImpl = makeFetch([
      {
        match: isFollowers,
        responses: [
          { status: 401, body: { error: 'Unauthorized', status: 401, message: 'Invalid OAuth token' } },
          { status: 200, body: { total: 5000 } },
        ],
      },
      { match: isStreams, responses: [{ status: 200, body: liveStreamBody(42) }] },
      {
        match: isToken,
        responses: [{ status: 200, body: { access_token: 'rotated-access', expires_in: 3600 } }],
      },
    ])
    const adapter = new TwitchAdapter(buildDeps({ fetch: fetchImpl }), TENANT)

    const data = await adapter.fetchAudienceMetrics('141991764', RANGE)

    // Order: followers(401) → token refresh → followers(retry) → streams.
    const urls = vi.mocked(fetchImpl).mock.calls.map((c) => String(c[0]))
    expect(urls).toHaveLength(4)
    expect(isFollowers(urls[0]!)).toBe(true)
    expect(urls[1]!.startsWith(TOKEN_URL)).toBe(true)
    expect(isFollowers(urls[2]!)).toBe(true)
    expect(isStreams(urls[3]!)).toBe(true)

    // The retry (and every later Helix call) authenticates with the rotated
    // access token written back by the refresh flow, not the stale one.
    expect(headersAt(fetchImpl, isFollowers, 0).Authorization).toBe('Bearer stale-access-token')
    expect(headersAt(fetchImpl, isFollowers, 1).Authorization).toBe('Bearer rotated-access')
    expect(headersAt(fetchImpl, isStreams, 0).Authorization).toBe('Bearer rotated-access')

    expect(db.updateOAuthToken).toHaveBeenCalledTimes(1)
    expect(data.records).toHaveLength(1)
    expect(data.records[0]).toEqual({
      date: '2026-01-01',
      views: 42,
      watchTimeMinutes: 0,
      subscribersGained: 0,
      subscribersLost: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      _followersTotal: 5000,
    })
  })
})
