// ── Twitch platform adapter (AUDIENCE-ONLY) ────────────────────────────────
//
// Implements {@link PlatformAdapter} against the Twitch Helix API, bridging
// CRUM's encrypted-at-rest OAuth tokens (see ../oauth-encryption.ts and
// ../../db/video-queries.ts) to the plain-bearer HTTP client in ../twitch-api.ts.
//
// Capability reality-check (verified against the Twitch API):
//   * Twitch exposes NO revenue dollars. Payouts (subs/Bits/ad revenue) live
//     only behind the private creator dashboard; Helix's `/subscriptions`
//     endpoint returns subscriber RECORDS (tier 1000/2000/3000), never money.
//     So `supportsRevenue` is false and `fetchEarnings` is deliberately NOT
//     implemented — it inherits the BasePlatformAdapter throw
//     (`[twitch] fetchEarnings is not implemented`). The daily earnings sync
//     skips adapters reporting `supportsRevenue === false`; sponsorship
//     revenue for Twitch arrives through the Phase 4 email-intake path.
//   * Daily per-video audience analytics (`GET /helix/analytics/streams`)
//     require this app to be an installed, live Extension on the channel and
//     typically return empty for normal creators. Without an Extension there
//     is NO per-broadcaster daily time series at all, so audience data here
//     is SPARSE and best-effort: {@link fetchAudienceMetrics} produces a
//     single summary row from what a regular user token can read —
//     `GET /channels/followers` (total followers) and `GET /streams`
//     (current `viewer_count`).
//
// Design constraints worth knowing before editing:
//   * The `oauth_tokens` row carries only the encrypted access/refresh tokens;
//     it does NOT store the channel id, and every Helix call additionally
//     needs the app `Client-Id` from `VIDEO_TWITCH_CLIENT_ID`. The interface
//     methods resolve the tenant's latest twitch token automatically.
//   * All side-effecting collaborators (DB reads/writes, encryption,
//     transport) are injected through {@link TwitchAdapterDeps} so unit tests
//     can supply fakes without touching Postgres or the network.

import * as videoQueries from '../../db/video-queries'
import type { OAuthToken, VideoPlatform } from '../../db/types'
import type { CrumEnv } from '../../config/env'
import { decryptToken, unpackEncrypted, encryptToken, packEncrypted } from '../oauth-encryption'
import { TwitchApiError, getFollowersTotal, getStream, refreshTwitchAccessToken } from '../twitch-api'
import type { TwitchApiConfig } from '../twitch-api'
import { BasePlatformAdapter } from './base'
import type { DateRange, AudienceData, AudienceRecord } from './index'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Adapter-level failures (missing config, missing token rows, decrypt errors). */
export class TwitchAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TwitchAdapterError'
  }
}

// ---------------------------------------------------------------------------
// Extra fields the adapter may attach (see fetchAudienceMetrics below)
// ---------------------------------------------------------------------------

/**
 * The adapter keeps the shared {@link AudienceRecord} contract intact but is
 * allowed to return *extra* fields (same precedent as YouTube's `_perVideo`):
 * the record's `views` slot holds the point-in-time live `viewer_count`, so
 * the channel's total follower count rides along as `_followersTotal` — the
 * contract has no total-followers field (`subscribersGained`/`Lost` are
 * daily deltas, which Twitch only exposes via Extension-scoped analytics).
 * The DB layer's `video_audience_metrics.metadata` jsonb column can persist
 * it; whether to store it is the caller's decision.
 */
type TwitchAudienceRecord = AudienceRecord & { _followersTotal?: number }

// ---------------------------------------------------------------------------
// Dependency injection surface
// ---------------------------------------------------------------------------

/**
 * Everything the adapter touches that a unit test should be able to fake. The
 * three DB fields are typed against the real `video-queries` exports so fakes
 * stay honest; the encryption helpers mirror `video-oauth.ts`'s packing rules.
 */
export interface TwitchAdapterDeps {
  env: CrumEnv
  getOAuthTokenById: typeof videoQueries.getOAuthTokenById
  getLatestOAuthToken: typeof videoQueries.getLatestOAuthToken
  updateOAuthToken: typeof videoQueries.updateOAuthToken
  encryptAndPack: (plaintext: string, key: Buffer) => string
  getEncryptionKey: (env: CrumEnv) => Buffer
  api?: TwitchApiConfig
}

// ---------------------------------------------------------------------------
// Default dependency wiring (production path)
// ---------------------------------------------------------------------------

/**
 * Load the AES key from `env.OAUTH_ENCRYPTION_KEY`.
 *
 * `OAUTH_ENCRYPTION_KEY` is still declared in `video-oauth.ts` but has not yet
 * been added to the typed `CrumEnv` schema, so — matching the existing
 * `getPlatformCredentials()` convention in `video-oauth.ts` (and the YouTube
 * adapter) — we read it through an env record view rather than a
 * `(env as any)` property access.
 */
export function defaultGetEncryptionKey(env: CrumEnv): Buffer {
  const hex = (env as unknown as Record<string, string | undefined>).OAUTH_ENCRYPTION_KEY
  if (!hex) {
    throw new TwitchAdapterError('OAUTH_ENCRYPTION_KEY is not configured; cannot decrypt Twitch OAuth tokens.')
  }
  return Buffer.from(hex, 'hex')
}

/** Encrypt `plaintext` and pack it as base64url(`iv || ciphertext || tag`). */
export function defaultEncryptAndPack(plaintext: string, key: Buffer): string {
  const { encrypted, iv, tag } = encryptToken(plaintext, key)
  return packEncrypted(encrypted, iv, tag).toString('base64url')
}

/** Production defaults, wired from the real modules. */
export function makeDefaultTwitchDeps(env: CrumEnv): TwitchAdapterDeps {
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
export function createTwitchAdapter(env: CrumEnv, tenantId: string): TwitchAdapter {
  return new TwitchAdapter(makeDefaultTwitchDeps(env), tenantId)
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Grace window before `expires_at` so we refresh a hair early. */
const EXPIRY_BUFFER_MS = 60_000

export class TwitchAdapter extends BasePlatformAdapter {
  readonly platform: VideoPlatform = 'twitch'

  /**
   * Twitch has no revenue API: payout dollars (subs/Bits/ads) are private
   * creator-dashboard data and Helix `/subscriptions` only returns subscriber
   * tier records, never money. The earnings sync must skip this adapter.
   * `supportsAudienceMetrics` inherits `true` from the base class — the
   * sparse summary described at the top of this file is still worth storing.
   */
  override readonly supportsRevenue = false

  // NOTE: fetchEarnings is intentionally NOT implemented — it inherits the
  // BasePlatformAdapter throw (`[twitch] fetchEarnings is not implemented`).

  private readonly deps: TwitchAdapterDeps
  private readonly tenantId: string
  private readonly api: TwitchApiConfig

  constructor(deps: TwitchAdapterDeps, tenantId: string) {
    super()
    this.deps = deps
    this.tenantId = tenantId
    this.api = deps.api ?? {}
  }

  // -- PlatformAdapter interface ---------------------------------------------

  /**
   * Best-effort single summary row. Twitch Helix does not expose daily
   * per-video audience analytics without an installed Extension on the
   * channel, so instead of a per-day series we emit ONE AudienceRecord dated
   * `dateRange.start` assembled from the publicly-readable summary
   * endpoints, with every unavailable field explicitly zeroed:
   *
   *   * `views`              — current live `viewer_count` from `/streams`;
   *                            0 when the channel is offline. This is a
   *                            point-in-time average-concurrent-viewers
   *                            snapshot, NOT cumulative daily views (Helix
   *                            gives no daily view counts for a normal user
   *                            token) — we store it as the closest available
   *                            audience signal rather than fabricating one.
   *   * `_followersTotal`    — total followers from `/channels/followers`
   *                            (extra field; omitted when that call fails).
   *   * `subscribersGained`  — 0: Helix exposes no follower/subscriber delta
   *                            history without Extension-scoped analytics.
   *   * `subscribersLost`    — 0: same reason.
   *   * `watchTimeMinutes`   — 0: minute-watched data is Extension-only.
   *   * `likes` / `comments` / `shares` — 0: Twitch has no public engagement
   *                            aggregates for a channel.
   *
   * Each endpoint is independently best-effort: a failure (missing scope,
   * transient 5xx, 401 that survives the refresh-and-retry) logs a warning
   * and degrades that field to its zero/absent value instead of losing the
   * whole summary row.
   */
  override async fetchAudienceMetrics(channelId: string, dateRange: DateRange): Promise<AudienceData> {
    // Every Helix request needs the app Client-Id alongside the bearer token.
    const clientId = this.requireClientId()
    const tokenId = await this.resolveLatestTokenId()

    let followersTotal: number | null = null
    try {
      followersTotal = await this.callHelix(tokenId, (accessToken) =>
        getFollowersTotal(channelId, accessToken, clientId, this.api),
      )
    } catch (err) {
      console.warn(`[CRUM] Twitch channel ${channelId}: follower total unavailable: ${describeErr(err)}`)
    }

    // `viewer_count` for the summary row's `views`; 0 when offline (getStream
    // answers null) or when the endpoint failed — documented above.
    let viewerCount = 0
    try {
      const stream = await this.callHelix(tokenId, (accessToken) =>
        getStream(channelId, accessToken, clientId, this.api),
      )
      viewerCount = stream?.viewerCount ?? 0
    } catch (err) {
      console.warn(`[CRUM] Twitch channel ${channelId}: live viewer count unavailable: ${describeErr(err)}`)
    }

    const record: TwitchAudienceRecord = {
      date: dateRange.start,
      views: viewerCount,
      // All fields below are structurally unavailable for non-Extension apps
      // (see the fetchAudienceMetrics doc comment); zeroed honestly, never
      // estimated or fabricated.
      watchTimeMinutes: 0,
      // Total-follower DELTAS are not exposed by Helix (only the absolute
      // total, which rides along as `_followersTotal` when readable).
      subscribersGained: 0,
      subscribersLost: 0,
      likes: 0,
      comments: 0,
      shares: 0,
    }
    if (followersTotal !== null) record._followersTotal = followersTotal

    return {
      channelId,
      platform: this.platform,
      dateRange,
      records: [record],
      fetchedAt: new Date().toISOString(),
    }
  }

  override async refreshOAuthToken(tokenId: string): Promise<void> {
    await this.refreshTokenRow(tokenId)
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
    if (!row.refresh_token_encrypted) {
      throw new TwitchAdapterError(
        `OAuth token ${tokenId} has no refresh token stored; the Twitch channel must be re-connected.`,
      )
    }

    const key = this.deps.getEncryptionKey(this.deps.env)
    const refreshToken = this.unpackAndDecrypt(row.refresh_token_encrypted, key)

    const clientId = this.deps.env.VIDEO_TWITCH_CLIENT_ID
    const clientSecret = this.deps.env.VIDEO_TWITCH_CLIENT_SECRET
    if (!clientId || !clientSecret) {
      throw new TwitchAdapterError(
        'VIDEO_TWITCH_CLIENT_ID and VIDEO_TWITCH_CLIENT_SECRET must be configured to refresh Twitch tokens.',
      )
    }

    const { accessToken, expiresIn, refreshToken: rotated } = await refreshTwitchAccessToken(
      refreshToken,
      clientId,
      clientSecret,
      this.api,
    )

    // Twitch rotates BOTH tokens on refresh. `updateOAuthToken`'s real
    // signature (src/db/video-queries.ts, OAuthTokenUpdates) accepts
    // { accessTokenEnc, refreshTokenEnc, expiresAt, scopes }, so we can and
    // must persist the rotated refresh token when the response carries one —
    // writing only the access token would silently brick the next refresh.
    const accessTokenEnc = this.deps.encryptAndPack(accessToken, key)
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
    if (rotated) {
      const refreshTokenEnc = this.deps.encryptAndPack(rotated, key)
      await this.deps.updateOAuthToken(this.tenantId, tokenId, {
        accessTokenEnc,
        refreshTokenEnc,
        expiresAt,
      })
    } else {
      await this.deps.updateOAuthToken(this.tenantId, tokenId, { accessTokenEnc, expiresAt })
    }
  }

  private async resolveLatestTokenId(): Promise<string> {
    const row = await this.deps.getLatestOAuthToken(this.tenantId, 'twitch')
    if (!row) {
      throw new TwitchAdapterError(
        `No Twitch OAuth token found for tenant ${this.tenantId}; connect a channel first.`,
      )
    }
    return row.id
  }

  private async loadToken(tokenId: string): Promise<OAuthToken> {
    const row = await this.deps.getOAuthTokenById(this.tenantId, tokenId)
    if (!row) {
      throw new TwitchAdapterError(`OAuth token ${tokenId} not found for tenant ${this.tenantId}.`)
    }
    return row
  }

  private requireClientId(): string {
    const clientId = this.deps.env.VIDEO_TWITCH_CLIENT_ID
    if (!clientId) {
      throw new TwitchAdapterError(
        'VIDEO_TWITCH_CLIENT_ID must be configured; every Twitch Helix request requires the Client-Id header.',
      )
    }
    return clientId
  }

  private decryptAccessToken(row: OAuthToken): string {
    if (!row.access_token_encrypted) {
      throw new TwitchAdapterError(`OAuth token ${row.id} has no access token stored.`)
    }
    const key = this.deps.getEncryptionKey(this.deps.env)
    return this.unpackAndDecrypt(row.access_token_encrypted, key)
  }

  private unpackAndDecrypt(packed: string, key: Buffer): string {
    const { encrypted, iv, tag } = unpackEncrypted(Buffer.from(packed, 'base64url'))
    return decryptToken(encrypted, key, iv, tag)
  }

  /**
   * Run a Helix call with a fresh access token. A 401 (unambiguously a
   * bad/expired token, unlike a 403 missing-scope denial) triggers a single
   * refresh-and-retry, mirroring the YouTube adapter's recovery path.
   */
  private async callHelix<T>(tokenId: string, fn: (accessToken: string) => Promise<T>): Promise<T> {
    const accessToken = await this.getFreshAccessToken(tokenId)
    try {
      return await fn(accessToken)
    } catch (err) {
      if (err instanceof TwitchApiError && err.status === 401) {
        const retried = await this.forceFreshAccessToken(tokenId)
        return await fn(retried)
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

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
