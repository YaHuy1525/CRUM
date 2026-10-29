// ── TikTok platform adapter (AUDIENCE-ONLY) ─────────────────────────────────
//
// Implements {@link PlatformAdapter} against the TikTok Display API v2,
// bridging CRUM's encrypted-at-rest OAuth tokens (see ../oauth-encryption.ts
// and ../../db/video-queries.ts) to the plain-bearer HTTP client in
// ../tiktok-api.ts.
//
// WHY THIS ADAPTER IS AUDIENCE-ONLY (read before editing):
//   * The TikTok Display API exposes NO revenue/monetization dollars and NO
//     watch-time. `supportsRevenue` is therefore hard-overridden to `false`;
//     `fetchEarnings` is deliberately left unimplemented so it inherits the
//     BasePlatformAdapter "not implemented" throw. The daily earnings sync
//     skips adapters that report `supportsRevenue === false`, so nothing calls
//     it. Sponsorship revenue for TikTok is captured via the Phase 4
//     email-intake path instead.
//   * There is also NO per-day time series and NO follower delta. `video/query`
//     only returns the account's current videos with cumulative-to-date
//     engagement counters (play/digg/comment/share). `fetchAudienceMetrics`
//     therefore cannot build a daily {@link AudienceRecord} series: it
//     aggregates ALL fetched videos into a SINGLE summary row stamped at
//     `dateRange.start`. `watchTimeMinutes`, `subscribersGained` and
//     `subscribersLost` are reported as 0 because the API genuinely does not
//     provide them — this is a faithful mapping, not a missing implementation.
//
// Design constraints shared with the YouTube adapter:
//   * The `oauth_tokens` row carries only encrypted access/refresh tokens; it
//     does NOT store the TikTok account (open_id) id. So the adapter is built
//     per (tenant, platform) pair and either resolves the latest token
//     automatically (interface methods) or binds an explicit token row via
//     `withChannel(...)`.
//   * TikTok ROTATES the refresh token on every grant; {@link refreshOAuthToken}
//     re-encrypts and persists the new refresh token, not just the access token.
//   * All side-effecting collaborators (DB reads/writes, encryption, transport)
//     are injected through {@link TiktokAdapterDeps} so unit tests can supply
//     fakes without touching Postgres or the network.

import * as videoQueries from '../../db/video-queries'
import type { OAuthToken, VideoPlatform } from '../../db/types'
import type { CrumEnv } from '../../config/env'
import { decryptToken, unpackEncrypted, encryptToken, packEncrypted } from '../oauth-encryption'
import { TiktokApiError, queryVideos, refreshTiktokAccessToken } from '../tiktok-api'
import type { TiktokApiConfig, TiktokVideoStat } from '../tiktok-api'
import { BasePlatformAdapter } from './base'
import type { DateRange, AudienceData, AudienceRecord } from './index'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Adapter-level failures (missing config, missing token rows, decrypt errors). */
export class TiktokAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TiktokAdapterError'
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
export interface TiktokAdapterDeps {
  env: CrumEnv
  getOAuthTokenById: typeof videoQueries.getOAuthTokenById
  getLatestOAuthToken: typeof videoQueries.getLatestOAuthToken
  updateOAuthToken: typeof videoQueries.updateOAuthToken
  encryptAndPack: (plaintext: string, key: Buffer) => string
  getEncryptionKey: (env: CrumEnv) => Buffer
  api?: TiktokApiConfig
}

// ---------------------------------------------------------------------------
// Default dependency wiring (production path)
// ---------------------------------------------------------------------------

/**
 * Load the AES key from `env.OAUTH_ENCRYPTION_KEY`.
 *
 * Read through an env record view (not a `(env as any)` property access),
 * matching the convention in the YouTube adapter and `video-oauth.ts`.
 */
export function defaultGetEncryptionKey(env: CrumEnv): Buffer {
  const hex = (env as unknown as Record<string, string | undefined>).OAUTH_ENCRYPTION_KEY
  if (!hex) {
    throw new TiktokAdapterError('OAUTH_ENCRYPTION_KEY is not configured; cannot decrypt TikTok OAuth tokens.')
  }
  return Buffer.from(hex, 'hex')
}

/** Encrypt `plaintext` and pack it as base64url(`iv || ciphertext || tag`). */
export function defaultEncryptAndPack(plaintext: string, key: Buffer): string {
  const { encrypted, iv, tag } = encryptToken(plaintext, key)
  return packEncrypted(encrypted, iv, tag).toString('base64url')
}

/**
 * Read the TikTok OAuth client credentials from env.
 *
 * `VIDEO_TIKTOK_CLIENT_ID` / `VIDEO_TIKTOK_CLIENT_SECRET` are consumed through
 * the same env-record-cast convention used for `OAUTH_ENCRYPTION_KEY` above, so
 * this adapter does not depend on the keys being added to the typed `CrumEnv`
 * schema (TikTok calls the id `client_key`).
 */
function readClientCredentials(env: CrumEnv): { clientKey: string; clientSecret: string } {
  const record = env as unknown as Record<string, string | undefined>
  const clientKey = record.VIDEO_TIKTOK_CLIENT_ID
  const clientSecret = record.VIDEO_TIKTOK_CLIENT_SECRET
  if (!clientKey || !clientSecret) {
    throw new TiktokAdapterError(
      'VIDEO_TIKTOK_CLIENT_ID and VIDEO_TIKTOK_CLIENT_SECRET must be configured to refresh TikTok tokens.',
    )
  }
  return { clientKey, clientSecret }
}

/** Production defaults, wired from the real modules. */
export function makeDefaultTiktokDeps(env: CrumEnv): TiktokAdapterDeps {
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
export function createTiktokAdapter(env: CrumEnv, tenantId: string): TiktokAdapter {
  return new TiktokAdapter(makeDefaultTiktokDeps(env), tenantId)
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Grace window before `expires_at` so we refresh a hair early. */
const EXPIRY_BUFFER_MS = 60_000

/**
 * Defensive cap on `video/query` pagination. TikTok drives `has_more`, so this
 * only trips if the API keeps echoing `has_more: true` forever — it turns a
 * runaway loop into a bounded, logged fetch.
 */
const MAX_VIDEO_PAGES = 50

export class TiktokAdapter extends BasePlatformAdapter {
  readonly platform: VideoPlatform = 'tiktok'

  /**
   * TikTok's public Display API exposes no monetization figures, so this
   * adapter is audience-only. Overridden from the base default of `true`; the
   * earnings sync uses this flag to skip the adapter rather than error.
   */
  override readonly supportsRevenue: boolean = false

  // `supportsAudienceMetrics` intentionally inherits the base `true`.

  private readonly deps: TiktokAdapterDeps
  private readonly tenantId: string
  private readonly api: TiktokApiConfig

  constructor(deps: TiktokAdapterDeps, tenantId: string) {
    super()
    this.deps = deps
    this.tenantId = tenantId
    this.api = deps.api ?? {}
  }

  // -- bound client ----------------------------------------------------------

  /**
   * Bind the adapter to a specific OAuth token row and TikTok account id. Use
   * this when the caller already knows both (e.g. read from the
   * `video_channels` row). The top-level {@link fetchAudienceMetrics} resolves
   * the tenant's latest token automatically instead. `tenantId` is carried for
   * interface symmetry; refresh delegates to this adapter's (tenant-scoped)
   * construction, so it must match for the binding to be meaningful.
   */
  withChannel(tenantId: string, oauthTokenId: string, platformChannelId: string): TiktokChannelClient {
    return new TiktokChannelClient(this, tenantId, oauthTokenId, platformChannelId)
  }

  // -- PlatformAdapter interface ---------------------------------------------

  /**
   * `fetchEarnings` is NOT implemented: it inherits the BasePlatformAdapter
   * throw, which is correct because `supportsRevenue` is `false` and the daily
   * sync never reaches it for TikTok.
   */

  override async fetchAudienceMetrics(channelId: string, dateRange: DateRange): Promise<AudienceData> {
    const tokenId = await this.resolveLatestTokenId()
    return this.fetchAudienceMetricsFor(tokenId, channelId, dateRange)
  }

  override async refreshOAuthToken(tokenId: string): Promise<void> {
    await this.refreshTokenRow(tokenId)
  }

  // -- internals reused by TiktokChannelClient -------------------------------

  /**
   * Aggregate the account's whole current video catalog into a SINGLE summary
   * {@link AudienceRecord}. See the header comment: the Display API has no
   * daily granularity, no watch-time, and no follower deltas, so a time series
   * is impossible and zeroed fields are faithful rather than placeholder.
   *
   * @internal
   */
  async fetchAudienceMetricsFor(
    tokenId: string,
    platformChannelId: string,
    dateRange: DateRange,
  ): Promise<AudienceData> {
    const videos = await this.runVideoQuery(tokenId)
    const record = aggregateSummary(videos, dateRange.start)

    return {
      channelId: platformChannelId,
      platform: this.platform,
      dateRange,
      records: [record],
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
    if (!row.refresh_token_encrypted) {
      throw new TiktokAdapterError(
        `OAuth token ${tokenId} has no refresh token stored; the TikTok account must be re-connected.`,
      )
    }

    const key = this.deps.getEncryptionKey(this.deps.env)
    const refreshToken = this.unpackAndDecrypt(row.refresh_token_encrypted, key)

    const { clientKey, clientSecret } = readClientCredentials(this.deps.env)

    const { accessToken, expiresIn, refreshToken: rotated } = await refreshTiktokAccessToken(
      refreshToken,
      clientKey,
      clientSecret,
      this.api,
    )

    const accessTokenEnc = this.deps.encryptAndPack(accessToken, key)
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

    // TikTok ROTATES the refresh token on every grant. Persist the new one when
    // present, otherwise the next refresh would use a revoked token. When TikTok
    // reuses it, we write back only the access token + expiry (like Google).
    if (rotated) {
      const refreshTokenEnc = this.deps.encryptAndPack(rotated, key)
      await this.deps.updateOAuthToken(this.tenantId, tokenId, { accessTokenEnc, refreshTokenEnc, expiresAt })
      return
    }
    await this.deps.updateOAuthToken(this.tenantId, tokenId, { accessTokenEnc, expiresAt })
  }

  private async resolveLatestTokenId(): Promise<string> {
    const row = await this.deps.getLatestOAuthToken(this.tenantId, 'tiktok')
    if (!row) {
      throw new TiktokAdapterError(
        `No TikTok OAuth token found for tenant ${this.tenantId}; connect an account first.`,
      )
    }
    return row.id
  }

  private async loadToken(tokenId: string): Promise<OAuthToken> {
    const row = await this.deps.getOAuthTokenById(this.tenantId, tokenId)
    if (!row) {
      throw new TiktokAdapterError(`OAuth token ${tokenId} not found for tenant ${this.tenantId}.`)
    }
    return row
  }

  private decryptAccessToken(row: OAuthToken): string {
    if (!row.access_token_encrypted) {
      throw new TiktokAdapterError(`OAuth token ${row.id} has no access token stored.`)
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
   * Fetch every page of the account's video stats with a fresh access token. A
   * 401 (a bad/expired token, which TikTok surfaces distinctly) triggers a
   * single refresh-and-restart of pagination with the rotated token.
   */
  private async runVideoQuery(tokenId: string): Promise<TiktokVideoStat[]> {
    const accessToken = await this.getFreshAccessToken(tokenId)
    try {
      return await this.paginateVideos(accessToken)
    } catch (err) {
      if (err instanceof TiktokApiError && err.status === 401) {
        const retried = await this.forceFreshAccessToken(tokenId)
        return this.paginateVideos(retried)
      }
      throw err
    }
  }

  private async paginateVideos(accessToken: string): Promise<TiktokVideoStat[]> {
    const all: TiktokVideoStat[] = []
    let cursor: number | undefined
    let pages = 0
    for (;;) {
      const page = await queryVideos(accessToken, { cursor }, this.api)
      all.push(...page.videos)
      if (!page.hasMore) break
      cursor = page.cursor
      if (++pages >= MAX_VIDEO_PAGES) {
        console.warn(`[CRUM] TikTok video query hit the ${MAX_VIDEO_PAGES}-page safety cap; returning partial data.`)
        break
      }
    }
    return all
  }
}

// ---------------------------------------------------------------------------
// Bound client
// ---------------------------------------------------------------------------

/**
 * A {@link TiktokAdapter} bound to one (tenant, OAuth token row, TikTok account)
 * triple, returned by {@link TiktokAdapter.withChannel}. Exposes the same
 * audience/refresh surface as the adapter but always uses the explicit token
 * row instead of resolving the tenant's latest token. No `fetchEarnings`: the
 * adapter is revenue-incapable.
 */
export class TiktokChannelClient {
  constructor(
    private readonly adapter: TiktokAdapter,
    private readonly tenantId: string,
    private readonly oauthTokenId: string,
    private readonly platformChannelId: string,
  ) {}

  fetchAudienceMetrics(dateRange: DateRange): Promise<AudienceData> {
    return this.adapter.fetchAudienceMetricsFor(this.oauthTokenId, this.platformChannelId, dateRange)
  }

  refreshOAuthToken(): Promise<void> {
    // refreshOAuthToken is tenant-scoped on the adapter; the bound tenant id must
    // match the adapter's for this to be meaningful (caller's responsibility).
    return this.adapter.refreshOAuthToken(this.oauthTokenId)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collapse a list of per-video counters into the single audience summary row.
 * Only the four engagement totals are meaningful; the three TikTok cannot supply
 * (watch time + follower deltas) are reported as 0.
 */
function aggregateSummary(videos: TiktokVideoStat[], date: string): AudienceRecord {
  let views = 0
  let likes = 0
  let comments = 0
  let shares = 0
  for (const v of videos) {
    views += v.views
    likes += v.likes
    comments += v.comments
    shares += v.shares
  }
  return {
    date,
    views,
    // The Display API exposes no watch-time and no follower deltas — these are
    // structurally unavailable, so they are legitimately zero, not placeholders.
    watchTimeMinutes: 0,
    subscribersGained: 0,
    subscribersLost: 0,
    likes,
    comments,
    shares,
  }
}

function needsRefresh(row: OAuthToken): boolean {
  if (!row.access_token_encrypted) return true
  if (!row.expires_at) return false
  const expiresAt = Date.parse(row.expires_at)
  if (Number.isNaN(expiresAt)) return false
  return expiresAt - EXPIRY_BUFFER_MS <= Date.now()
}
