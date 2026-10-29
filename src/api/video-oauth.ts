import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import type { CrumEnv } from '../config/env'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import type { TenantRequestContext } from '../mastra/tenant-context'
import {
  encryptToken,
  decryptToken,
  packEncrypted,
  unpackEncrypted,
} from '../video/oauth-encryption'
import {
  insertOAuthToken,
  getOAuthTokenById,
  deleteOAuthToken,
  getVideoChannelById,
  updateVideoChannel,
} from '../db/video-queries'
import type { VideoPlatform } from '../db/video-queries'

export interface VideoOAuthRouterDeps {
  env: CrumEnv
}

const PlatformSchema = z.enum(['youtube', 'tiktok', 'instagram', 'twitch'])
const IdSchema = z.string().uuid()

const STATE_TTL_MS = 10 * 60 * 1000

// ── Platform OAuth configuration ─────────────────────────────────────────────

interface PlatformOAuthConfig {
  authUrl: string
  tokenUrl: string
  revokeUrl: string | null
  scopes: string[]
  clientIdEnvKey: string
  clientSecretEnvKey: string
  redirectUriEnvKey: string
  defaultRedirectUri: string
}

const PLATFORM_CONFIGS: Record<VideoPlatform, PlatformOAuthConfig> = {
  youtube: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    scopes: [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/youtubeanalytics.readonly',
      // Monetization reports (estimatedRevenue/cpm/rpm). Without this the
      // earnings sync falls back to zero-revenue rows (see youtube.ts
      // isMissingMonetaryScopeError).
      'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
    ],
    clientIdEnvKey: 'VIDEO_YOUTUBE_CLIENT_ID',
    clientSecretEnvKey: 'VIDEO_YOUTUBE_CLIENT_SECRET',
    redirectUriEnvKey: 'VIDEO_YOUTUBE_REDIRECT_URI',
    defaultRedirectUri: 'http://localhost:4111/api/video/oauth/callback/youtube',
  },
  tiktok: {
    authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    revokeUrl: null,
    scopes: ['user.info.basic', 'video.list'],
    clientIdEnvKey: 'VIDEO_TIKTOK_CLIENT_ID',
    clientSecretEnvKey: 'VIDEO_TIKTOK_CLIENT_SECRET',
    redirectUriEnvKey: 'VIDEO_TIKTOK_REDIRECT_URI',
    defaultRedirectUri: 'http://localhost:4111/api/video/oauth/callback/tiktok',
  },
  instagram: {
    authUrl: 'https://api.instagram.com/oauth/authorize',
    tokenUrl: 'https://api.instagram.com/oauth/access_token',
    revokeUrl: null,
    scopes: ['user_profile', 'user_media'],
    clientIdEnvKey: 'VIDEO_INSTAGRAM_CLIENT_ID',
    clientSecretEnvKey: 'VIDEO_INSTAGRAM_CLIENT_SECRET',
    redirectUriEnvKey: 'VIDEO_INSTAGRAM_REDIRECT_URI',
    defaultRedirectUri: 'http://localhost:4111/api/video/oauth/callback/instagram',
  },
  twitch: {
    authUrl: 'https://id.twitch.tv/oauth2/authorize',
    tokenUrl: 'https://id.twitch.tv/oauth2/token',
    revokeUrl: 'https://id.twitch.tv/oauth2/revoke',
    scopes: ['user:read:email', 'channel:read:subscriptions'],
    clientIdEnvKey: 'VIDEO_TWITCH_CLIENT_ID',
    clientSecretEnvKey: 'VIDEO_TWITCH_CLIENT_SECRET',
    redirectUriEnvKey: 'VIDEO_TWITCH_REDIRECT_URI',
    defaultRedirectUri: 'http://localhost:4111/api/video/oauth/callback/twitch',
  },
}

// ── Encryption helpers ───────────────────────────────────────────────────────

function getEncryptionKey(env: CrumEnv): Buffer {
  const hex = env.OAUTH_ENCRYPTION_KEY
  if (!hex) {
    throw new Error('OAUTH_ENCRYPTION_KEY is not configured')
  }
  return Buffer.from(hex, 'hex')
}

function encryptAndPack(plaintext: string, key: Buffer): string {
  const { encrypted, iv, tag } = encryptToken(plaintext, key)
  return packEncrypted(encrypted, iv, tag).toString('base64url')
}

function unpackAndDecrypt(packed: string, key: Buffer): string {
  const { encrypted, iv, tag } = unpackEncrypted(Buffer.from(packed, 'base64url'))
  return decryptToken(encrypted, key, iv, tag)
}

// ── State management (HMAC-signed) ──────────────────────────────────────────

interface OAuthStatePayload {
  tenantId: string
  userId: string
  platform: VideoPlatform
  exp: number
  nonce: string
}

function signOAuthState(payload: OAuthStatePayload, secret: string): string {
  const { createHmac } = require('node:crypto') as typeof import('node:crypto')
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const mac = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}

function verifyOAuthState(state: string, secret: string): OAuthStatePayload | null {
  const { createHmac, timingSafeEqual } = require('node:crypto') as typeof import('node:crypto')
  const dot = state.lastIndexOf('.')
  if (dot <= 0) return null
  const body = state.slice(0, dot)
  const mac = state.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const a = Buffer.from(mac, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<OAuthStatePayload>
    if (
      typeof payload.tenantId !== 'string' ||
      typeof payload.userId !== 'string' ||
      typeof payload.platform !== 'string' ||
      typeof payload.exp !== 'number' ||
      typeof payload.nonce !== 'string'
    ) {
      return null
    }
    if (payload.exp <= Date.now()) return null
    return {
      tenantId: payload.tenantId,
      userId: payload.userId,
      platform: payload.platform as VideoPlatform,
      exp: payload.exp,
      nonce: payload.nonce,
    }
  } catch {
    return null
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type IdentityOrError = { identity: TenantRequestContext } | { error: Response }

function getPlatformCredentials(
  env: CrumEnv,
  platform: VideoPlatform,
): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const config = PLATFORM_CONFIGS[platform]
  const envRecord = env as unknown as Record<string, string | undefined>
  const clientId = envRecord[config.clientIdEnvKey]
  const clientSecret = envRecord[config.clientSecretEnvKey]
  const redirectUri = envRecord[config.redirectUriEnvKey] ?? config.defaultRedirectUri
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret, redirectUri }
}

function buildAuthUrl(
  platform: VideoPlatform,
  creds: { clientId: string; redirectUri: string },
  state: string,
): string {
  const config = PLATFORM_CONFIGS[platform]
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: creds.redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
  })

  // Platform-specific parameters
  if (platform === 'youtube') {
    params.set('access_type', 'offline')
    params.set('include_granted_scopes', 'true')
    params.set('prompt', 'consent')
  } else if (platform === 'twitch') {
    params.set('force_verify', 'true')
  }

  return `${config.authUrl}?${params.toString()}`
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

async function exchangeCodeForTokens(
  platform: VideoPlatform,
  code: string,
  creds: { clientId: string; clientSecret: string; redirectUri: string },
): Promise<TokenResponse> {
  const config = PLATFORM_CONFIGS[platform]
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: creds.redirectUri,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (platform === 'twitch') {
    headers['Client-ID'] = creds.clientId
  }

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers,
    body: body.toString(),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token exchange failed (${res.status}): ${text}`)
  }

  return res.json() as Promise<TokenResponse>
}

async function revokePlatformToken(
  platform: VideoPlatform,
  token: string,
  clientId: string,
): Promise<void> {
  const config = PLATFORM_CONFIGS[platform]
  if (!config.revokeUrl) return

  const body = new URLSearchParams({ token })
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (platform === 'twitch') {
    body.set('client_id', clientId)
    headers['Client-ID'] = clientId
  }

  try {
    const res = await fetch(config.revokeUrl, {
      method: 'POST',
      headers,
      body: body.toString(),
    })
    if (!res.ok) {
      console.warn(`[CRUM] Token revocation failed for ${platform}: ${res.status}`)
    }
  } catch (err) {
    console.warn(`[CRUM] Token revocation call failed for ${platform}:`, err)
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export function createVideoOAuthRouter(deps: VideoOAuthRouterDeps): Hono {
  const { env } = deps
  const app = new Hono().basePath('/api/video/oauth')

  const auth = async (c: Context): Promise<IdentityOrError> => {
    try {
      return { identity: await resolveIdentity((name) => c.req.header(name), env) }
    } catch (err) {
      if (err instanceof IdentityError) {
        return { error: c.json({ error: 'unauthorized', reason: err.reason }, 401) }
      }
      throw err
    }
  }

  // POST /api/video/oauth/connect/:platform - initiate OAuth flow
  app.post('/connect/:platform', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const platform = PlatformSchema.safeParse(c.req.param('platform'))
    if (!platform.success) {
      return c.json(
        { error: 'invalid_platform', detail: 'platform must be youtube, tiktok, instagram, or twitch' },
        400,
      )
    }

    const creds = getPlatformCredentials(env, platform.data)
    if (!creds) {
      const config = PLATFORM_CONFIGS[platform.data]
      return c.json(
        {
          error: 'oauth_not_configured',
          detail: `Set ${config.clientIdEnvKey} and ${config.clientSecretEnvKey} environment variables.`,
        },
        503,
      )
    }

    const secret = env.APPROVAL_HMAC_SECRET
    if (!secret) {
      return c.json(
        { error: 'state_secret_missing', detail: 'APPROVAL_HMAC_SECRET is required for OAuth state signing.' },
        503,
      )
    }

    try {
      const statePayload: OAuthStatePayload = {
        tenantId: gate.identity.tenantId,
        userId: gate.identity.userId,
        platform: platform.data,
        exp: Date.now() + STATE_TTL_MS,
        nonce: randomBytes(12).toString('hex'),
      }
      const state = signOAuthState(statePayload, secret)
      const url = buildAuthUrl(platform.data, creds, state)

      return c.json({ url, redirectUri: creds.redirectUri, platform: platform.data })
    } catch (err) {
      console.error('[CRUM] OAuth connect initiation failed:', err)
      return c.json({ error: 'internal_error', detail: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  // GET /api/video/oauth/callback/:platform - handle OAuth callback
  app.get('/callback/:platform', async (c) => {
    const platform = PlatformSchema.safeParse(c.req.param('platform'))
    if (!platform.success) {
      return c.json({ error: 'invalid_platform' }, 400)
    }

    const code = c.req.query('code')
    const state = c.req.query('state')
    const error = c.req.query('error')

    if (error) {
      const desc = c.req.query('error_description') ?? 'OAuth provider returned an error'
      return c.json({ error: 'oauth_error', detail: desc }, 400)
    }

    if (!code || !state) {
      return c.json({ error: 'missing_params', detail: 'code and state are required' }, 400)
    }

    const secret = env.APPROVAL_HMAC_SECRET
    if (!secret) {
      return c.json({ error: 'state_secret_missing' }, 503)
    }

    const statePayload = verifyOAuthState(state, secret)
    if (!statePayload) {
      return c.json({ error: 'invalid_state', detail: 'State parameter is invalid or expired.' }, 400)
    }

    if (statePayload.platform !== platform.data) {
      return c.json({ error: 'platform_mismatch' }, 400)
    }

    const creds = getPlatformCredentials(env, platform.data)
    if (!creds) {
      return c.json({ error: 'oauth_not_configured' }, 503)
    }

    let encKey: Buffer
    try {
      encKey = getEncryptionKey(env)
    } catch {
      return c.json({ error: 'encryption_not_configured', detail: 'OAUTH_ENCRYPTION_KEY is required.' }, 503)
    }

    try {
      const tokenRes = await exchangeCodeForTokens(platform.data, code, creds)

      if (tokenRes.error) {
        return c.json(
          { error: 'token_exchange_failed', detail: tokenRes.error_description ?? tokenRes.error },
          400,
        )
      }

      if (!tokenRes.access_token && !tokenRes.refresh_token) {
        return c.json(
          { error: 'no_tokens', detail: 'The OAuth provider did not return any tokens.' },
          400,
        )
      }

      const accessTokenEnc = tokenRes.access_token
        ? encryptAndPack(tokenRes.access_token, encKey)
        : ''
      const refresh_token_enc = tokenRes.refresh_token
        ? encryptAndPack(tokenRes.refresh_token, encKey)
        : null
      const expiresAt = tokenRes.expires_in
        ? new Date(Date.now() + tokenRes.expires_in * 1000).toISOString()
        : null
      const scopes = tokenRes.scope ?? PLATFORM_CONFIGS[platform.data].scopes.join(' ')

      const tokenRow = await insertOAuthToken(
        statePayload.tenantId,
        {
          platform: platform.data,
          accessTokenEnc: accessTokenEnc || undefined,
          refreshTokenEnc: refresh_token_enc ?? '',
          tokenExpiresAt: expiresAt ?? undefined,
          scopes: scopes,
        },
      )

      // Redirect to success page or return JSON
      const accept = c.req.header('accept') ?? ''
      if (accept.includes('text/html')) {
        return c.redirect(`/video/oauth/success?tokenId=${tokenRow.id}&platform=${platform.data}`)
      }

      return c.json({
        ok: true,
        tokenId: tokenRow.id,
        platform: platform.data,
        scope: tokenRow.scope,
      })
    } catch (err) {
      console.error('[CRUM] OAuth callback failed:', err)
      return c.json({ error: 'internal_error', detail: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  // POST /api/video/oauth/disconnect/:channelId - revoke and delete tokens
  app.post('/disconnect/:channelId', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const channelId = IdSchema.safeParse(c.req.param('channelId'))
    if (!channelId.success) {
      return c.json({ error: 'invalid_id', detail: 'channelId must be a uuid' }, 400)
    }

    try {
      // Look up the channel to find its oauth_token_id
      const channel = await getVideoChannelById(gate.identity.tenantId, channelId.data)
      if (!channel) {
        return c.json({ error: 'not_found', detail: 'Channel not found.' }, 404)
      }

      if (!channel.oauth_token_id) {
        return c.json({ error: 'not_connected', detail: 'Channel has no OAuth token.' }, 404)
      }

      const tokenRow = await getOAuthTokenById(gate.identity.tenantId, channel.oauth_token_id)
      if (!tokenRow) {
        // Token row is missing; just clear the reference
        await updateVideoChannel(gate.identity.tenantId, channelId.data, { oauthTokenId: null })
        return c.json({ ok: true, detail: 'Token reference cleared (token row was missing).' })
      }

      // Attempt to revoke the token at the platform
      const creds = getPlatformCredentials(env, tokenRow.platform)
      if (creds && tokenRow.refresh_token_encrypted) {
        try {
          const encKey = getEncryptionKey(env)
          const refreshPlain = unpackAndDecrypt(tokenRow.refresh_token_encrypted, encKey)
          await revokePlatformToken(tokenRow.platform, refreshPlain, creds.clientId)
        } catch (revokeErr) {
          console.warn('[CRUM] Token revocation call failed (continuing with local cleanup):', revokeErr)
        }
      }

      // Delete the token row
      await deleteOAuthToken(gate.identity.tenantId, tokenRow.id)

      // Clear the channel's oauth_token_id reference
      await updateVideoChannel(gate.identity.tenantId, channelId.data, {
        oauthTokenId: null,
      })

      return c.json({ ok: true, detail: 'OAuth token revoked and removed.' })
    } catch (err) {
      console.error('[CRUM] OAuth disconnect failed:', err)
      return c.json({ error: 'internal_error', detail: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  return app
}
