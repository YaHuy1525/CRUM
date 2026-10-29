// ── Instagram platform adapter (audience-only) ──────────────────────────────
//
// Implements {@link PlatformAdapter} against the Meta "Instagram API with
// Instagram Login" Graph surface, bridging CRUM's encrypted-at-rest OAuth
// tokens (see ../oauth-encryption.ts and ../../db/video-queries.ts) to the
// plain-bearer HTTP client in ../instagram-api.ts.
//
// Design constraints worth knowing before editing:
//   * Instagram exposes NO revenue dollars in any public API — payouts live
//     only in the private creator dashboard. This adapter is therefore
//     AUDIENCE-ONLY: `supportsRevenue` is false and `fetchEarnings` is NOT
//     implemented (the BasePlatformAdapter throw is inherited on purpose; the
//     daily earnings sync skips adapters that report `false`).
//   * The `oauth_tokens` row carries only the encrypted tokens; it does NOT
//     store the account id, so this adapter resolves the tenant's latest
//     Instagram token row automatically for each call.
//   * Token refresh differs from YouTube: there is NO classic refresh_token.
//     `refreshOAuthToken` decrypts the stored ACCESS token, calls
//     `refresh_access_token?grant_type=ig_refresh_token` with it, and stores
//     the returned token as the new access token with its fresh expiresAt.
//   * Metrics available on media objects: video_views, like_count,
//     comment_count, share_count (+ engagement/impressions/reach insights).
//     There is no watch-time and no follower-delta on this surface, so
//     watchTimeMinutes and subscribersGained/Lost are always 0.
//   * All side-effecting collaborators (DB reads/writes, encryption,
//     transport) are injected through {@link InstagramAdapterDeps} so unit
//     tests can supply fakes without touching Postgres or the network.

import * as videoQueries from '../../db/video-queries'
import type { OAuthToken, VideoPlatform } from '../../db/types'
import type { CrumEnv } from '../../config/env'
import { decryptToken, unpackEncrypted, encryptToken, packEncrypted } from '../oauth-encryption'
import {
  InstagramApiError,
  getMediaWithInsights,
  refreshInstagramAccessToken,
} from '../instagram-api'
import type { InstagramApiConfig, InstagramMediaObject, MediaInsightsQueryParams } from '../instagram-api'
import { BasePlatformAdapter } from './base'
import type { DateRange, AudienceData, AudienceRecord } from './index'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Adapter-level failures (missing config, missing token rows, decrypt errors). */
export class InstagramAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstagramAdapterError'
  }
}

// ---------------------------------------------------------------------------
// Dependency injection surface
// ---------------------------------------------------------------------------

/**
 * Everything the adapter touches that a unit test should be able to fake. The
 * three DB fields are typed against the real `video-queries` exports so fakes
 * stay honest; the encryption helpers mirror `video-oauth.ts`'s packing rules.
 */
export interface InstagramAdapterDeps {
  env: CrumEnv
  getOAuthTokenById: typeof videoQueries.getOAuthTokenById
  getLatestOAuthToken: typeof videoQueries.getLatestOAuthToken
  updateOAuthToken: typeof videoQueries.updateOAuthToken
  encryptAndPack: (plaintext: string, key: Buffer) => string
  getEncryptionKey: (env: CrumEnv) => Buffer
  api?: InstagramApiConfig
}

// ---------------------------------------------------------------------------
// Default dependency wiring (production path)
// ---------------------------------------------------------------------------

/**
 * Load the AES key from `env.OAUTH_ENCRYPTION_KEY`.
 *
 * `OAUTH_ENCRYPTION_KEY` is still declared in `video-oauth.ts` but has not yet
 * been added to the typed `CrumEnv` schema, so — matching the existing
 * `getPlatformCredentials()` convention in `video-oauth.ts` — we read it through
 * an env record view rather than a `(env as any)` property access.
 */
export function defaultGetEncryptionKey(env: CrumEnv): Buffer {
  const hex = (env as unknown as Record<string, string | undefined>).OAUTH_ENCRYPTION_KEY
  if (!hex) {
    throw new InstagramAdapterError('OAUTH_ENCRYPTION_KEY is not configured; cannot decrypt Instagram OAuth tokens.')
  }
  return Buffer.from(hex, 'hex')
}

/** Encrypt `plaintext` and pack it as base64url(`iv || ciphertext || tag`). */
export function defaultEncryptAndPack(plaintext: string, key: Buffer): string {
  const { encrypted, iv, tag } = encryptToken(plaintext, key)
  return packEncrypted(encrypted, iv, tag).toString('base64url')
}

/**
 * Instagram app credentials. `VIDEO_INSTAGRAM_CLIENT_ID`/`VIDEO_INSTAGRAM_CLIENT_SECRET`
 * may not be present on the typed `CrumEnv` schema yet, so we read them through
 * the same env record view convention {@link defaultGetEncryptionKey} uses —
 * this keeps the adapter compiling against either shape of `env.ts`.
 */
function readAppCredentials(env: CrumEnv): { clientId?: string; clientSecret?: string } {
  const record = env as unknown as Record<string, string | undefined>
  return {
    clientId: record.VIDEO_INSTAGRAM_CLIENT_ID,
    clientSecret: record.VIDEO_INSTAGRAM_CLIENT_SECRET,
  }
}

/** Production defaults, wired from the real modules. */
export function makeDefaultInstagramDeps(env: CrumEnv): InstagramAdapterDeps {
  return {
    env,
    getOAuthTokenById: videoQueries.getOAuthTokenById,
    getLatestOAuthToken: videoQueries.getLatestOAuthToken,
    updateOAuthToken: videoQueries.updateOAuthToken,
    encryptAndPack: defaultEncryptAndPack,
    getEncryptionKey: defaultGetEncryptionKey,
  }
}

/** Convenience factory so the scheduler wiring only needs `(env, tenantId)`. */
export function createInstagramAdapter(env: CrumEnv, tenantId: string): InstagramAdapter {
  return new InstagramAdapter(makeDefaultInstagramDeps(env), tenantId)
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Grace window before `expires_at` so we refresh a hair early. */
const EXPIRY_BUFFER_MS = 60_000

export class InstagramAdapter extends BasePlatformAdapter {
  readonly platform: VideoPlatform = 'instagram'

  /**
   * Instagram has no public revenue API; audience metrics only.
   * `supportsAudienceMetrics` stays `true` (inherited default).
   */
  override readonly supportsRevenue: boolean = false

  private readonly deps: InstagramAdapterDeps
  private readonly tenantId: string
  private readonly api: InstagramApiConfig

  constructor(deps: InstagramAdapterDeps, tenantId: string) {
    super()
    this.deps = deps
    this.tenantId = tenantId
    this.api = deps.api ?? {}
  }

  // -- PlatformAdapter interface ---------------------------------------------

  // NOTE: `fetchEarnings` is deliberately NOT implemented. The base class
  // throw is the intended behaviour for an audience-only platform, and the
  // earnings sync gates on `supportsRevenue === false`.

  override async fetchAudienceMetrics(channelId: string, dateRange: DateRange): Promise<AudienceData> {
    const tokenId = await this.resolveLatestTokenId()
    return this.fetchAudienceMetricsFor(tokenId, channelId, dateRange)
  }

  override async refreshOAuthToken(tokenId: string): Promise<void> {
    await this.refreshTokenRow(tokenId)
  }

  // -- internals -------------------------------------------------------------

  /** @internal */
  async fetchAudienceMetricsFor(
    tokenId: string,
    platformAccountId: string,
    dateRange: DateRange,
  ): Promise<AudienceData> {
    const media = await this.runMediaFetch(tokenId, {
      since: dateRange.start,
      // Extend `until` to the end of the last day so same-day media posted
      // after midnight-UTC of `end` are not cut off server-side.
      until: `${dateRange.end}T23:59:59Z`,
    })

    const records = bucketMediaByDate(media, dateRange)

    return {
      channelId: platformAccountId,
      platform: this.platform,
      dateRange,
      records,
      fetchedAt: new Date().toISOString(),
    }
  }

  // -- token plumbing --------------------------------------------------------

  /** @internal */
  async getFreshAccessToken(tokenId: string): Promise<string> {
    const row = await this.loadToken(tokenId)
    if (!needsRefresh(row)) {
      return this.decryptAccessToken(row)
    }
    await this.refreshTokenRow(tokenId)
    const reloaded = await this.loadToken(tokenId)
    return this.decryptAccessToken(reloaded)
  }

  /** Force a refresh even when we cannot tell expiry (401 recovery path). */
  private async forceFreshAccessToken(tokenId: string): Promise<string> {
    await this.refreshTokenRow(tokenId)
    const reloaded = await this.loadToken(tokenId)
    return this.decryptAccessToken(reloaded)
  }

  private async refreshTokenRow(tokenId: string): Promise<void> {
    const row = await this.loadToken(tokenId)

    // Instagram Login has no refresh_token: the stored ACCESS token is the
    // credential we rotate. A row without one cannot be refreshed at all.
    if (!row.access_token_encrypted) {
      throw new InstagramAdapterError(
        `OAuth token ${tokenId} has no access token stored; the Instagram account must be re-connected.`,
      )
    }

    const key = this.deps.getEncryptionKey(this.deps.env)
    const currentAccessToken = this.unpackAndDecrypt(row.access_token_encrypted, key)

    const { clientId, clientSecret } = readAppCredentials(this.deps.env)
    if (!clientId || !clientSecret) {
      throw new InstagramAdapterError(
        'VIDEO_INSTAGRAM_CLIENT_ID and VIDEO_INSTAGRAM_CLIENT_SECRET must be configured to refresh Instagram tokens.',
      )
    }

    const { accessToken, expiresIn } = await refreshInstagramAccessToken(
      currentAccessToken,
      clientId,
      clientSecret,
      this.api,
    )

    // Meta returns a brand-new access token (and NO replacement credential —
    // there is nothing else to store), so we write back the packed access token
    // plus its new expiry and leave `refresh_token_encrypted` untouched.
    const accessTokenEnc = this.deps.encryptAndPack(accessToken, key)
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
    await this.deps.updateOAuthToken(this.tenantId, tokenId, { accessTokenEnc, expiresAt })
  }

  private async resolveLatestTokenId(): Promise<string> {
    const row = await this.deps.getLatestOAuthToken(this.tenantId, 'instagram')
    if (!row) {
      throw new InstagramAdapterError(
        `No Instagram OAuth token found for tenant ${this.tenantId}; connect an account first.`,
      )
    }
    return row.id
  }

  private async loadToken(tokenId: string): Promise<OAuthToken> {
    const row = await this.deps.getOAuthTokenById(this.tenantId, tokenId)
    if (!row) {
      throw new InstagramAdapterError(`OAuth token ${tokenId} not found for tenant ${this.tenantId}.`)
    }
    return row
  }

  private decryptAccessToken(row: OAuthToken): string {
    if (!row.access_token_encrypted) {
      throw new InstagramAdapterError(`OAuth token ${row.id} has no access token stored.`)
    }
    const key = this.deps.getEncryptionKey(this.deps.env)
    return this.unpackAndDecrypt(row.access_token_encrypted, key)
  }

  private unpackAndDecrypt(packed: string, key: Buffer): string {
    const { encrypted, iv, tag } = unpackEncrypted(Buffer.from(packed, 'base64url'))
    return decryptToken(encrypted, key, iv, tag)
  }

  // -- query helpers ---------------------------------------------------------

  /**
   * Run a media query with a fresh access token. A 401 (unambiguously a
   * bad/expired token on the Graph API) triggers a single refresh-and-retry.
   */
  private async runMediaFetch(
    tokenId: string,
    params: MediaInsightsQueryParams,
  ): Promise<InstagramMediaObject[]> {
    const accessToken = await this.getFreshAccessToken(tokenId)
    try {
      return await getMediaWithInsights(accessToken, params, this.api)
    } catch (err) {
      if (err instanceof InstagramApiError && err.status === 401) {
        const retried = await this.forceFreshAccessToken(tokenId)
        return await getMediaWithInsights(retried, params, this.api)
      }
      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function needsRefresh(row: OAuthToken): boolean {
  if (!row.access_token_encrypted) return true
  if (!row.expires_at) return false
  const expiresAt = Date.parse(row.expires_at)
  if (Number.isNaN(expiresAt)) return false
  return expiresAt - EXPIRY_BUFFER_MS <= Date.now()
}

/**
 * Aggregate the media objects that fall inside `dateRange` into ONE record per
 * distinct UTC calendar date of `timestamp`, sorted ascending. Media with an
 * unparseable timestamp are skipped. No media in range ⇒ empty records.
 *
 * Metric mapping (verified Graph surface limits):
 *   views              = Σ video_views   likes = Σ like_count
 *   comments           = Σ comment_count shares = Σ share_count
 *   watchTimeMinutes   = 0 (Instagram reports no watch time)
 *   subscribersGained/Lost = 0 (no follower-delta metric on this endpoint)
 */
function bucketMediaByDate(media: InstagramMediaObject[], dateRange: DateRange): AudienceRecord[] {
  const startMs = rangeBoundaryMs(dateRange.start, 'start')
  const endMs = rangeBoundaryMs(dateRange.end, 'end')

  const byDate = new Map<string, AudienceRecord>()
  for (const item of media) {
    const createdMs = Date.parse(item.timestamp)
    if (Number.isNaN(createdMs)) continue
    if (startMs != null && createdMs < startMs) continue
    if (endMs != null && createdMs > endMs) continue

    const date = new Date(createdMs).toISOString().slice(0, 10)
    const bucket = byDate.get(date) ?? {
      date,
      views: 0,
      watchTimeMinutes: 0,
      subscribersGained: 0,
      subscribersLost: 0,
      likes: 0,
      comments: 0,
      shares: 0,
    }
    bucket.views += item.video_views
    bucket.likes += item.like_count
    bucket.comments += item.comment_count
    bucket.shares += item.share_count
    byDate.set(date, bucket)
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** Inclusive day boundaries in UTC; unparseable bounds are ignored (open-ended). */
function rangeBoundaryMs(value: string, edge: 'start' | 'end'): number | undefined {
  const ms = Date.parse(edge === 'start' ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`)
  return Number.isNaN(ms) ? undefined : ms
}
