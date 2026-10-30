// tests/integration/api/video-api.test.ts
//
// Video channel CRUD and OAuth flow tests.  The DB layer is mocked so no
// DATABASE_URL is needed; the identity gate is tested the same way as in
// crm.test.ts -- every route must resolve a tenant/user/role before any
// business logic runs.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

// ── Mock the DB layer ────────────────────────────────────────────────────────

const videoQueries = vi.hoisted(() => ({
  listVideoChannels: vi.fn(),
  getVideoChannelById: vi.fn(),
  insertVideoChannel: vi.fn(),
  updateVideoChannel: vi.fn(),
  deleteVideoChannel: vi.fn(),
  insertOAuthToken: vi.fn(),
  getOAuthTokenById: vi.fn(),
  deleteOAuthToken: vi.fn(),
}))

vi.mock('../../../src/db/video-queries', () => videoQueries)

vi.mock('../../../src/db/client', () => ({
  getDbClient: () => ({
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    connect: () => Promise.reject(new Error('route tests must not open a transaction connection')),
  }),
  closeDbClient: async () => {},
}))

import { createVideoChannelsRouter } from '../../../src/api/video-channels'
import { createVideoOAuthRouter } from '../../../src/api/video-oauth'
import { parseEnv } from '../../../src/config/env'

// ── Constants ────────────────────────────────────────────────────────────────

const SECRET = 'r'.repeat(40)
const ENC_KEY = 'a'.repeat(64)
const ENCRYPTION_KEY_HEX = ENC_KEY

const tenant = (over = '550e8400-e29b-41d4-a716-446655440000') => over
const user = (over = '660e8400-e29b-41d4-a716-446655440009') => over
const otherTenant = '770e8400-e29b-41d4-a716-446655440099'
const channelId = 'aaaa1111-bbbb-4ccc-8ddd-eeee22223333'

const AUTH = {
  'x-tenant-id': tenant(),
  'x-user-id': user(),
  'x-user-role': 'admin',
}

function env(overrides: Record<string, string> = {}) {
  return parseEnv({
    APPROVAL_HMAC_SECRET: SECRET,
    OAUTH_ENCRYPTION_KEY: ENCRYPTION_KEY_HEX,
    VIDEO_YOUTUBE_CLIENT_ID: 'yt-client-id',
    VIDEO_YOUTUBE_CLIENT_SECRET: 'yt-client-secret',
    ...overrides,
  })
}

function channelsRouter(overrides: Record<string, string> = {}): Hono {
  return createVideoChannelsRouter({ env: env(overrides) })
}

function oauthRouter(overrides: Record<string, string> = {}): Hono {
  return createVideoOAuthRouter({ env: env(overrides) })
}

async function json<T = Record<string, unknown>>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}

function channelRow(over: Record<string, unknown> = {}) {
  return {
    id: channelId,
    tenant_id: tenant(),
    platform: 'youtube',
    platform_channel_id: 'UCxxxxx',
    channel_name: 'Test Channel',
    channel_url: 'https://youtube.com/@test',
    customer_id: null,
    contact_id: null,
    ownership: 'self',
    status: 'active',
    oauth_token_id: null,
    last_sync_at: null,
    created_at: '2026-10-20T09:00:00.000Z',
    updated_at: '2026-10-20T09:00:00.000Z',
    ...over,
  }
}

// ── Reset mocks ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════════
//  Channel CRUD
// ═══════════════════════════════════════════════════════════════════════════

describe('identity gate', () => {
  it('refuses channel list without identity headers', async () => {
    const res = await channelsRouter().request('/api/video/channels')
    expect(res.status).toBe(401)
    expect(videoQueries.listVideoChannels).not.toHaveBeenCalled()
  })

  it('refuses channel create without identity headers', async () => {
    const res = await channelsRouter().request('/api/video/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'youtube', platformChannelId: 'UCx', ownership: 'self' }),
    })
    expect(res.status).toBe(401)
    expect(videoQueries.insertVideoChannel).not.toHaveBeenCalled()
  })

  it('refuses OAuth connect without identity headers', async () => {
    const res = await oauthRouter().request('/api/video/oauth/connect/youtube', {
      method: 'POST',
    })
    expect(res.status).toBe(401)
  })
})

describe('tenant isolation', () => {
  it('passes the verified tenant id to listVideoChannels, not a header it re-reads', async () => {
    videoQueries.listVideoChannels.mockResolvedValue([])

    await channelsRouter().request('/api/video/channels', { headers: AUTH })

    expect(videoQueries.listVideoChannels).toHaveBeenCalledWith(tenant(), {})
  })

  it('passes the verified tenant id to getVideoChannelById', async () => {
    videoQueries.getVideoChannelById.mockResolvedValue(channelRow())

    await channelsRouter().request(`/api/video/channels/${channelId}`, { headers: AUTH })

    expect(videoQueries.getVideoChannelById).toHaveBeenCalledWith(tenant(), channelId)
  })

  it('scopes insert to the verified tenant', async () => {
    videoQueries.insertVideoChannel.mockResolvedValue(channelRow())

    await channelsRouter().request('/api/video/channels', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'youtube',
        platformChannelId: 'UCxxxxx',
        ownership: 'self',
      }),
    })

    expect(videoQueries.insertVideoChannel).toHaveBeenCalledWith(
      tenant(),
      'youtube',
      'UCxxxxx',
      undefined,
      undefined,
      undefined,
      undefined,
      'self',
    )
  })

  it('scopes delete to the verified tenant', async () => {
    videoQueries.deleteVideoChannel.mockResolvedValue(true)

    await channelsRouter().request(`/api/video/channels/${channelId}`, {
      method: 'DELETE',
      headers: AUTH,
    })

    expect(videoQueries.deleteVideoChannel).toHaveBeenCalledWith(tenant(), channelId)
  })

  it('a different tenant header reaches the DB as a different tenant id', async () => {
    videoQueries.listVideoChannels.mockResolvedValue([])

    await channelsRouter().request('/api/video/channels', {
      headers: { ...AUTH, 'x-tenant-id': otherTenant },
    })

    expect(videoQueries.listVideoChannels).toHaveBeenCalledWith(otherTenant, {})
  })
})

describe('GET /api/video/channels', () => {
  it('returns a paginated list with hasMore', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => channelRow({ id: `ch-${i}` }))
    videoQueries.listVideoChannels.mockResolvedValue(rows)

    const body = await json<{ items: unknown[]; total: number; hasMore: boolean; limit: number; offset: number }>(
      channelsRouter().request('/api/video/channels?limit=2&offset=0', { headers: AUTH }),
    )

    expect(body.items).toHaveLength(2)
    expect(body.total).toBe(3)
    expect(body.hasMore).toBe(true)
    expect(body.limit).toBe(2)
    expect(body.offset).toBe(0)
  })

  it('forwards platform and status filters', async () => {
    videoQueries.listVideoChannels.mockResolvedValue([])

    await channelsRouter().request('/api/video/channels?platform=youtube&status=active', {
      headers: AUTH,
    })

    expect(videoQueries.listVideoChannels).toHaveBeenCalledWith(tenant(), {
      platform: 'youtube',
      status: 'active',
    })
  })

  it('rejects an invalid platform filter with 400', async () => {
    const res = await channelsRouter().request('/api/video/channels?platform=facebook', {
      headers: AUTH,
    })

    expect(res.status).toBe(400)
    expect(videoQueries.listVideoChannels).not.toHaveBeenCalled()
  })

  it('rejects a page size over 100', async () => {
    const res = await channelsRouter().request('/api/video/channels?limit=500', {
      headers: AUTH,
    })

    expect(res.status).toBe(400)
    expect(videoQueries.listVideoChannels).not.toHaveBeenCalled()
  })
})

describe('GET /api/video/channels/:id', () => {
  it('returns the channel under a `channel` key', async () => {
    videoQueries.getVideoChannelById.mockResolvedValue(
      channelRow({ channel_name: 'My YT', platform: 'youtube' }),
    )

    const body = await json<{ channel: Record<string, unknown> }>(
      channelsRouter().request(`/api/video/channels/${channelId}`, { headers: AUTH }),
    )

    expect(body.channel).toMatchObject({ id: channelId, channel_name: 'My YT', platform: 'youtube' })
  })

  it('returns 404 when the channel does not exist', async () => {
    videoQueries.getVideoChannelById.mockResolvedValue(null)

    const res = await channelsRouter().request(`/api/video/channels/${channelId}`, { headers: AUTH })
    expect(res.status).toBe(404)
  })

  it('rejects a non-uuid id with 400', async () => {
    const res = await channelsRouter().request('/api/video/channels/not-a-uuid', { headers: AUTH })
    expect(res.status).toBe(400)
    expect(videoQueries.getVideoChannelById).not.toHaveBeenCalled()
  })
})

describe('POST /api/video/channels', () => {
  it('creates a channel and returns 201', async () => {
    videoQueries.insertVideoChannel.mockResolvedValue(channelRow())

    const res = await channelsRouter().request('/api/video/channels', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'tiktok',
        platformChannelId: 'TT_12345',
        channelName: 'My TikTok',
        ownership: 'client',
      }),
    })

    expect(res.status).toBe(201)
    const body = await json<{ channel: Record<string, unknown> }>(res)
    expect(body.channel).toBeDefined()
  })

  it('rejects a body without required fields', async () => {
    const res = await channelsRouter().request('/api/video/channels', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'youtube' }),
    })

    expect(res.status).toBe(400)
    expect(videoQueries.insertVideoChannel).not.toHaveBeenCalled()
  })

  it('rejects an invalid platform enum', async () => {
    const res = await channelsRouter().request('/api/video/channels', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'facebook',
        platformChannelId: 'fb_1',
        ownership: 'self',
      }),
    })

    expect(res.status).toBe(400)
    expect(videoQueries.insertVideoChannel).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/video/channels/:id', () => {
  it('updates the channel and returns the result', async () => {
    videoQueries.updateVideoChannel.mockResolvedValue(
      channelRow({ channel_name: 'Updated Name', status: 'suspended' }),
    )

    const res = await channelsRouter().request(`/api/video/channels/${channelId}`, {
      method: 'PATCH',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ channelName: 'Updated Name', status: 'suspended' }),
    })

    expect(res.status).toBe(200)
    expect(videoQueries.updateVideoChannel).toHaveBeenCalledWith(tenant(), channelId, {
      channelName: 'Updated Name',
      status: 'suspended',
    })
  })

  it('returns 404 when the channel does not exist', async () => {
    videoQueries.updateVideoChannel.mockResolvedValue(null)

    const res = await channelsRouter().request(`/api/video/channels/${channelId}`, {
      method: 'PATCH',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ channelName: 'Ghost' }),
    })

    expect(res.status).toBe(404)
  })

  it('rejects an empty update body', async () => {
    const res = await channelsRouter().request(`/api/video/channels/${channelId}`, {
      method: 'PATCH',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    expect(videoQueries.updateVideoChannel).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/video/channels/:id', () => {
  it('returns 204 on successful deletion', async () => {
    videoQueries.deleteVideoChannel.mockResolvedValue(true)

    const res = await channelsRouter().request(`/api/video/channels/${channelId}`, {
      method: 'DELETE',
      headers: AUTH,
    })

    expect(res.status).toBe(204)
  })

  it('returns 404 when the channel does not exist', async () => {
    videoQueries.deleteVideoChannel.mockResolvedValue(false)

    const res = await channelsRouter().request(`/api/video/channels/${channelId}`, {
      method: 'DELETE',
      headers: AUTH,
    })

    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  OAuth flows
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/video/oauth/connect/:platform', () => {
  it('returns a redirect URL for a configured platform', async () => {
    const res = await oauthRouter().request('/api/video/oauth/connect/youtube', {
      method: 'POST',
      headers: AUTH,
    })

    expect(res.status).toBe(200)
    const body = await json<{ url: string; platform: string; redirectUri: string }>(res)
    expect(body.platform).toBe('youtube')
    expect(body.url).toContain('accounts.google.com')
    expect(body.url).toContain('state=')
    expect(body.redirectUri).toContain('youtube')
  })

  it('returns 503 when the platform is not configured', async () => {
    const bare = createVideoOAuthRouter({
      env: parseEnv({ APPROVAL_HMAC_SECRET: SECRET, OAUTH_ENCRYPTION_KEY: ENCRYPTION_KEY_HEX }),
    })

    const res = await bare.request('/api/video/oauth/connect/tiktok', {
      method: 'POST',
      headers: AUTH,
    })

    expect(res.status).toBe(503)
    const body = await json<{ error: string }>(res)
    expect(body.error).toBe('oauth_not_configured')
  })

  it('rejects an unknown platform with 400', async () => {
    const res = await oauthRouter().request('/api/video/oauth/connect/facebook', {
      method: 'POST',
      headers: AUTH,
    })

    expect(res.status).toBe(400)
  })

  it('includes the correct scopes for each platform', async () => {
    for (const platform of ['youtube', 'tiktok', 'instagram', 'twitch'] as const) {
      const envOverrides: Record<string, string> = {
        VIDEO_TIKTOK_CLIENT_ID: 'tt-id',
        VIDEO_TIKTOK_CLIENT_SECRET: 'tt-secret',
        VIDEO_INSTAGRAM_CLIENT_ID: 'ig-id',
        VIDEO_INSTAGRAM_CLIENT_SECRET: 'ig-secret',
        VIDEO_TWITCH_CLIENT_ID: 'tw-id',
        VIDEO_TWITCH_CLIENT_SECRET: 'tw-secret',
      }
      const res = await oauthRouter(envOverrides).request(`/api/video/oauth/connect/${platform}`, {
        method: 'POST',
        headers: AUTH,
      })
      expect(res.status, `connect for ${platform}`).toBe(200)
      const body = await json<{ url: string }>(res)
      const url = new URL(body.url)
      expect(url.searchParams.get('scope'), `scope for ${platform}`).toBeTruthy()
    }
  })
})

describe('GET /api/video/oauth/callback/:platform', () => {
  it('rejects a callback without code and state', async () => {
    const res = await oauthRouter().request('/api/video/oauth/callback/youtube', {
      headers: AUTH,
    })

    expect(res.status).toBe(400)
    const body = await json<{ error: string }>(res)
    expect(body.error).toBe('missing_params')
  })

  it('rejects an expired or tampered state', async () => {
    const res = await oauthRouter().request(
      '/api/video/oauth/callback/youtube?code=abc&state=expired.state',
      { headers: AUTH },
    )

    expect(res.status).toBe(400)
    const body = await json<{ error: string }>(res)
    expect(body.error).toBe('invalid_state')
  })

  it('passes through an error from the OAuth provider', async () => {
    const res = await oauthRouter().request(
      '/api/video/oauth/callback/youtube?error=access_denied&error_description=User+denied',
      { headers: AUTH },
    )

    expect(res.status).toBe(400)
    const body = await json<{ error: string; detail: string }>(res)
    expect(body.error).toBe('oauth_error')
    expect(body.detail).toContain('denied')
  })
})

describe('POST /api/video/oauth/disconnect/:channelId', () => {
  it('returns 404 when the channel does not exist', async () => {
    videoQueries.getVideoChannelById.mockResolvedValue(null)

    const res = await oauthRouter().request(`/api/video/oauth/disconnect/${channelId}`, {
      method: 'POST',
      headers: AUTH,
    })

    expect(res.status).toBe(404)
  })

  it('returns 404 when the channel has no oauth_token_id', async () => {
    videoQueries.getVideoChannelById.mockResolvedValue(channelRow({ oauth_token_id: null }))

    const res = await oauthRouter().request(`/api/video/oauth/disconnect/${channelId}`, {
      method: 'POST',
      headers: AUTH,
    })

    expect(res.status).toBe(404)
    const body = await json<{ error: string }>(res)
    expect(body.error).toBe('not_connected')
  })

  it('deletes the token and clears the channel reference', async () => {
    const tokenId = '11111111-2222-4333-8444-555555555555'
    videoQueries.getVideoChannelById.mockResolvedValue(channelRow({ oauth_token_id: tokenId }))
    videoQueries.getOAuthTokenById.mockResolvedValue({
      id: tokenId,
      tenant_id: tenant(),
      platform: 'youtube',
      access_token_encrypted: 'enc-access',
      refresh_token_encrypted: 'enc refresh',
      expires_at: null,
      scope: 'youtube.readonly',
      created_at: '2026-10-20T09:00:00.000Z',
      updated_at: '2026-10-20T09:00:00.000Z',
    })
    videoQueries.deleteOAuthToken.mockResolvedValue(true)
    videoQueries.updateVideoChannel.mockResolvedValue(channelRow({ oauth_token_id: null }))

    // Mock fetch for the revoke call
    vi.stubGlobal(
      'fetch',
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(''),
        }),
    )

    const res = await oauthRouter().request(`/api/video/oauth/disconnect/${channelId}`, {
      method: 'POST',
      headers: AUTH,
    })

    expect(res.status).toBe(200)
    expect(videoQueries.deleteOAuthToken).toHaveBeenCalledWith(tenant(), tokenId)
    expect(videoQueries.updateVideoChannel).toHaveBeenCalledWith(tenant(), channelId, {
      oauthTokenId: null,
    })

    vi.unstubAllGlobals()
  })
})
