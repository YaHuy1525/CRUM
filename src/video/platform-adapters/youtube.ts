// ── YouTube platform adapter ────────────────────────────────────────────────
//
// Implements {@link PlatformAdapter} against the real Google APIs, bridging
// CRUM's encrypted-at-rest OAuth tokens (see ../oauth-encryption.ts and
// ../../db/video-queries.ts) to the plain-bearer HTTP client in ../youtube-api.ts.
//
// Design constraints worth knowing before editing:
//   * The `oauth_tokens` row carries only the encrypted access/refresh tokens;
//     it does NOT store the channel id. So this adapter is constructed per
//     (tenant, platform) pair and either resolves the latest token automatically
//     (interface methods) or binds an explicit token row via `withChannel(...)`.
//   * Monetary metrics need the `yt-analytics-monetary.readonly` scope. When
//     Google denies them we retry once without the monetary columns so the
//     caller can still persist audience-derived earnings rows with zero revenue.
//   * All side-effecting collaborators (DB reads/writes, encryption, transport)
//     are injected through {@link YoutubeAdapterDeps} so unit tests can supply
//     fakes without touching Postgres or the network.

import * as videoQueries from '../../db/video-queries'
import type { OAuthToken, VideoPlatform } from '../../db/types'
import type { CrumEnv } from '../../config/env'
import { decryptToken, unpackEncrypted, encryptToken, packEncrypted } from '../oauth-encryption'
import {
  YoutubeApiError,
  queryAnalyticsReports,
  getChannelStatistics,
  refreshAccessToken,
} from '../youtube-api'
import type { AnalyticsReport, AnalyticsQueryParams, YoutubeApiConfig } from '../youtube-api'
import { BasePlatformAdapter } from './base'
import type {
  DateRange,
  EarningsData,
  EarningsRecord,
  AudienceData,
  AudienceRecord,
} from './index'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Adapter-level failures (missing config, missing token rows, decrypt errors). */
export class YoutubeAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YoutubeAdapterError'
  }
}

// ---------------------------------------------------------------------------
// Metric vocabulary
// ---------------------------------------------------------------------------

/** Metrics that require the `yt-analytics-monetary.readonly` scope. */
const MONETARY_METRICS = new Set([
  'estimatedRevenue',
  'estimatedAdRevenue',
  'grossRevenue',
  'cpm',
  'rpm',
])

const EARNINGS_METRICS = [
  'estimatedRevenue',
  'estimatedAdRevenue',
  'grossRevenue',
  'cpm',
  'rpm',
  'views',
]

const AUDIENCE_METRICS = [
  'views',
  'estimatedMinutesWatched',
  'subscribersGained',
  'subscribersLost',
]

const PER_VIDEO_METRICS = [
  'views',
  'estimatedMinutesWatched',
  'estimatedRevenue',
  'cpm',
  'rpm',
]

// ---------------------------------------------------------------------------
// Extra fields the adapter may attach (see fetchAudienceMetrics below)
// ---------------------------------------------------------------------------

/**
 * A single video's slice of the daily audience/earnings report, keyed back to
 * its date. Returned by the `dimensions=['video','date']` query.
 */
export interface PerVideoBreakdown {
  videoId: string
  date: string
  views: number
  watchTimeMinutes: number
  estimatedRevenue: number
  cpm: number
  rpm: number
}

/**
 * The adapter keeps the shared {@link AudienceRecord} contract intact but is
 * allowed to return *extra* fields: each daily record may carry a `_perVideo`
 * breakdown. The DB layer's `video_audience_metrics.metadata` jsonb column can
 * persist it — whether to store it is the caller's decision, so we attach it
 * rather than inventing a new column.
 */
type YoutubeAudienceRecord = AudienceRecord & { _perVideo?: PerVideoBreakdown[] }

// ---------------------------------------------------------------------------
// Dependency injection surface
// ---------------------------------------------------------------------------

/**
 * Everything the adapter touches that a unit test should be able to fake. The
 * three DB fields are typed against the real `video-queries` exports so fakes
 * stay honest; the encryption helpers mirror `video-oauth.ts`'s packing rules.
 */
export interface YoutubeAdapterDeps {
  env: CrumEnv
  getOAuthTokenById: typeof videoQueries.getOAuthTokenById
  getLatestOAuthToken: typeof videoQueries.getLatestOAuthToken
  updateOAuthToken: typeof videoQueries.updateOAuthToken
  encryptAndPack: (plaintext: string, key: Buffer) => string
  getEncryptionKey: (env: CrumEnv) => Buffer
  api?: YoutubeApiConfig
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
    throw new YoutubeAdapterError('OAUTH_ENCRYPTION_KEY is not configured; cannot decrypt YouTube OAuth tokens.')
  }
  return Buffer.from(hex, 'hex')
}

/** Encrypt `plaintext` and pack it as base64url(`iv || ciphertext || tag`). */
export function defaultEncryptAndPack(plaintext: string, key: Buffer): string {
  const { encrypted, iv, tag } = encryptToken(plaintext, key)
  return packEncrypted(encrypted, iv, tag).toString('base64url')
}

/** Production defaults, wired from the real modules. */
export function makeDefaultYoutubeDeps(env: CrumEnv): YoutubeAdapterDeps {
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
export function createYoutubeAdapter(env: CrumEnv, tenantId: string): YoutubeAdapter {
  return new YoutubeAdapter(makeDefaultYoutubeDeps(env), tenantId)
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Grace window before `expires_at` so we refresh a hair early. */
const EXPIRY_BUFFER_MS = 60_000

export class YoutubeAdapter extends BasePlatformAdapter {
  readonly platform: VideoPlatform = 'youtube'

  private readonly deps: YoutubeAdapterDeps
  private readonly tenantId: string
  private readonly api: YoutubeApiConfig

  constructor(deps: YoutubeAdapterDeps, tenantId: string) {
    super()
    this.deps = deps
    this.tenantId = tenantId
    this.api = deps.api ?? {}
  }

  // -- bound client ----------------------------------------------------------

  /**
   * Bind the adapter to a specific OAuth token row and platform channel id.
   * Use this when the caller already knows both (e.g. it read them from the
   * `video_channels` row). The top-level {@link fetchEarnings} / {@link
   * fetchAudienceMetrics} resolve the token automatically instead.
   */
  withChannel(tenantId: string, oauthTokenId: string, platformChannelId: string): YoutubeChannelClient {
    return new YoutubeChannelClient(this, tenantId, oauthTokenId, platformChannelId)
  }

  // -- PlatformAdapter interface ---------------------------------------------

  override async fetchEarnings(channelId: string, dateRange: DateRange): Promise<EarningsData> {
    const tokenId = await this.resolveLatestTokenId()
    return this.fetchEarningsFor(tokenId, channelId, dateRange)
  }

  override async fetchAudienceMetrics(channelId: string, dateRange: DateRange): Promise<AudienceData> {
    const tokenId = await this.resolveLatestTokenId()
    return this.fetchAudienceMetricsFor(tokenId, channelId, dateRange)
  }

  override async refreshOAuthToken(tokenId: string): Promise<void> {
    await this.refreshTokenRow(tokenId)
  }

  // -- internals reused by YoutubeChannelClient ------------------------------

  /** @internal */
  async fetchEarningsFor(tokenId: string, platformChannelId: string, dateRange: DateRange): Promise<EarningsData> {
    const base = this.reportParams(platformChannelId, dateRange, { dimensions: ['date'] })

    let report: AnalyticsReport
    try {
      report = await this.runQuery(tokenId, { ...base, metrics: EARNINGS_METRICS })
    } catch (err) {
      if (!isMissingMonetaryScopeError(err)) throw err
      // Channel/account is not monetized or the grant lacks the monetary scope:
      // retry WITHOUT the monetary columns so we still get the daily `views`
      // series and can persist audience-derived earnings rows with zero revenue.
      console.warn(
        `[CRUM] YouTube channel ${platformChannelId}: monetary metrics denied (missing ` +
          `yt-analytics-monetary.readonly scope); storing earnings rows with zero revenue.`,
      )
      const nonMonetary = EARNINGS_METRICS.filter((m) => !MONETARY_METRICS.has(m))
      report = await this.runQuery(tokenId, { ...base, metrics: nonMonetary })
    }

    return this.toEarningsData(platformChannelId, dateRange, report)
  }

  /** @internal */
  async fetchAudienceMetricsFor(
    tokenId: string,
    platformChannelId: string,
    dateRange: DateRange,
  ): Promise<AudienceData> {
    const dailyParams = this.reportParams(platformChannelId, dateRange, { dimensions: ['date'] })
    const daily = await this.runQuery(tokenId, { ...dailyParams, metrics: AUDIENCE_METRICS })

    // Per-video breakdown is best-effort: a scope denial or a transient failure
    // must not lose the daily audience rows.
    const perVideoByDate = await this.fetchPerVideoBreakdownFor(tokenId, platformChannelId, dateRange)

    const records: YoutubeAudienceRecord[] = daily.rows.map((row) => {
      const date = normalizeDate(row['date'])
      const record: YoutubeAudienceRecord = {
        date,
        views: pickNumber(row, 'views'),
        watchTimeMinutes: pickNumber(row, 'estimatedMinutesWatched'),
        subscribersGained: pickNumber(row, 'subscribersGained'),
        subscribersLost: pickNumber(row, 'subscribersLost'),
        // YouTube's Analytics v2 reports no longer expose likes/comments/shares
        // for channel-scoped queries, so they are reported as zero. If the API
        // starts returning them we can add `likes`/`comments`/`shares` to
        // AUDIENCE_METRICS and read them from `row` here.
        likes: 0,
        comments: 0,
        shares: 0,
      }
      const perVideo = perVideoByDate.get(date)
      if (perVideo && perVideo.length > 0) record._perVideo = perVideo
      return record
    })

    return {
      channelId: platformChannelId,
      platform: this.platform,
      dateRange,
      records,
      fetchedAt: new Date().toISOString(),
    }
  }

  /** @internal */
  async fetchChannelStatisticsFor(tokenId: string, platformChannelId: string) {
    const accessToken = await this.getFreshAccessToken(tokenId)
    return getChannelStatistics(platformChannelId, accessToken, this.api)
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
      throw new YoutubeAdapterError(
        `OAuth token ${tokenId} has no refresh token stored; the YouTube channel must be re-connected.`,
      )
    }

    const key = this.deps.getEncryptionKey(this.deps.env)
    const refreshToken = this.unpackAndDecrypt(row.refresh_token_encrypted, key)

    const clientId = this.deps.env.VIDEO_YOUTUBE_CLIENT_ID
    const clientSecret = this.deps.env.VIDEO_YOUTUBE_CLIENT_SECRET
    if (!clientId || !clientSecret) {
      throw new YoutubeAdapterError(
        'VIDEO_YOUTUBE_CLIENT_ID and VIDEO_YOUTUBE_CLIENT_SECRET must be configured to refresh YouTube tokens.',
      )
    }

    const { accessToken, expiresIn } = await refreshAccessToken(refreshToken, clientId, clientSecret, this.api)

    // Google rotates only the access token here, so we write back the access
    // token + its new expiry and leave the stored refresh token untouched.
    const accessTokenEnc = this.deps.encryptAndPack(accessToken, key)
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
    await this.deps.updateOAuthToken(this.tenantId, tokenId, { accessTokenEnc, expiresAt })
  }

  private async resolveLatestTokenId(): Promise<string> {
    const row = await this.deps.getLatestOAuthToken(this.tenantId, 'youtube')
    if (!row) {
      throw new YoutubeAdapterError(
        `No YouTube OAuth token found for tenant ${this.tenantId}; connect a channel first.`,
      )
    }
    return row.id
  }

  private async loadToken(tokenId: string): Promise<OAuthToken> {
    const row = await this.deps.getOAuthTokenById(this.tenantId, tokenId)
    if (!row) {
      throw new YoutubeAdapterError(`OAuth token ${tokenId} not found for tenant ${this.tenantId}.`)
    }
    return row
  }

  private decryptAccessToken(row: OAuthToken): string {
    if (!row.access_token_encrypted) {
      throw new YoutubeAdapterError(`OAuth token ${row.id} has no access token stored.`)
    }
    const key = this.deps.getEncryptionKey(this.deps.env)
    return this.unpackAndDecrypt(row.access_token_encrypted, key)
  }

  private unpackAndDecrypt(packed: string, key: Buffer): string {
    const { encrypted, iv, tag } = unpackEncrypted(Buffer.from(packed, 'base64url'))
    return decryptToken(encrypted, key, iv, tag)
  }

  // -- query helpers ---------------------------------------------------------

  private reportParams(
    platformChannelId: string,
    dateRange: DateRange,
    extra: Pick<AnalyticsQueryParams, 'dimensions'>,
  ): Pick<AnalyticsQueryParams, 'ids' | 'startDate' | 'endDate' | 'dimensions'> {
    return {
      ids: `channel==${platformChannelId}`,
      startDate: dateRange.start,
      endDate: dateRange.end,
      dimensions: extra.dimensions,
    }
  }

  /**
   * Run a report with a fresh access token. A 401 (unambiguously a bad/expired
   * token, unlike a 403 scope denial) triggers a single refresh-and-retry.
   */
  private async runQuery(tokenId: string, params: AnalyticsQueryParams): Promise<AnalyticsReport> {
    const accessToken = await this.getFreshAccessToken(tokenId)
    try {
      return await queryAnalyticsReports(accessToken, params, this.api)
    } catch (err) {
      if (err instanceof YoutubeApiError && err.status === 401) {
        const retried = await this.forceFreshAccessToken(tokenId)
        return await queryAnalyticsReports(retried, params, this.api)
      }
      throw err
    }
  }

  /** @internal — exposed so the bound client shares the same fallback logic. */
  async fetchPerVideoBreakdownFor(
    tokenId: string,
    platformChannelId: string,
    dateRange: DateRange,
  ): Promise<Map<string, PerVideoBreakdown[]>> {
    const map = new Map<string, PerVideoBreakdown[]>()
    const base = this.reportParams(platformChannelId, dateRange, { dimensions: ['video', 'date'] })

    let report: AnalyticsReport
    try {
      report = await this.runQuery(tokenId, { ...base, metrics: PER_VIDEO_METRICS })
    } catch (err) {
      if (isMissingMonetaryScopeError(err)) {
        const nonMonetary = PER_VIDEO_METRICS.filter((m) => !MONETARY_METRICS.has(m))
        try {
          report = await this.runQuery(tokenId, { ...base, metrics: nonMonetary })
        } catch (retryErr) {
          console.warn(`[CRUM] YouTube channel ${platformChannelId}: per-video breakdown unavailable: ${describeErr(retryErr)}`)
          return map
        }
      } else {
        console.warn(`[CRUM] YouTube channel ${platformChannelId}: per-video breakdown unavailable: ${describeErr(err)}`)
        return map
      }
    }

    for (const row of report.rows) {
      const videoId = String(row['video'] ?? '')
      if (!videoId) continue
      const date = normalizeDate(row['date'])
      const breakdown: PerVideoBreakdown = {
        videoId,
        date,
        views: pickNumber(row, 'views'),
        watchTimeMinutes: pickNumber(row, 'estimatedMinutesWatched'),
        estimatedRevenue: pickNumber(row, 'estimatedRevenue'),
        cpm: pickNumber(row, 'cpm'),
        rpm: pickNumber(row, 'rpm'),
      }
      const bucket = map.get(date)
      if (bucket) bucket.push(breakdown)
      else map.set(date, [breakdown])
    }
    return map
  }

  private toEarningsData(channelId: string, dateRange: DateRange, report: AnalyticsReport): EarningsData {
    const records: EarningsRecord[] = report.rows.map((row) => {
      const estimatedRevenue = pickNumber(row, 'estimatedRevenue')
      return {
        date: normalizeDate(row['date']),
        revenue_micros: Math.round(estimatedRevenue * 1_000_000),
        // TODO(currency): Google reports revenue in the channel's payout
        // currency but does not expose it per row here. Default to USD until the
        // channel currency is available from `channels.contentDetails` (region
        // / payout currency) so we can store the real currency code.
        currency: 'USD',
        // Analytics "views" is the closest available proxy for impressions in
        // the non-ad-specific report we request here.
        impressions: pickNumber(row, 'views'),
        estimated_revenue: estimatedRevenue,
      }
    })

    return {
      channelId,
      platform: this.platform,
      dateRange,
      records,
      fetchedAt: new Date().toISOString(),
    }
  }
}

// ---------------------------------------------------------------------------
// Bound client
// ---------------------------------------------------------------------------

/**
 * A {@link YoutubeAdapter} bound to one (tenant, OAuth token row, platform
 * channel) triple, returned by {@link YoutubeAdapter.withChannel}. It exposes
 * the same fetch surface as the adapter but always uses the explicit token row
 * instead of resolving the tenant's latest token.
 */
export class YoutubeChannelClient {
  constructor(
    private readonly adapter: YoutubeAdapter,
    private readonly tenantId: string,
    private readonly oauthTokenId: string,
    private readonly platformChannelId: string,
  ) {}

  async fetchEarnings(dateRange: DateRange): Promise<EarningsData> {
    return this.adapter.fetchEarningsFor(this.oauthTokenId, this.platformChannelId, dateRange)
  }

  async fetchAudienceMetrics(dateRange: DateRange): Promise<AudienceData> {
    return this.adapter.fetchAudienceMetricsFor(this.oauthTokenId, this.platformChannelId, dateRange)
  }

  /** Convenience: channel-level subscriber / view / video counts (Data API). */
  fetchChannelStatistics() {
    return this.adapter.fetchChannelStatisticsFor(this.oauthTokenId, this.platformChannelId)
  }

  refreshOAuthToken(): Promise<void> {
    // refreshOAuthToken is tenant-scoped on the adapter (constructed per
    // tenant); the bound tenant id must match the adapter's for this to be
    // meaningful, which is the responsibility of the caller that built it.
    return this.adapter.refreshOAuthToken(this.oauthTokenId)
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

function pickNumber(row: Record<string, number | string>, key: string): number {
  const value = row[key]
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/**
 * YouTube Analytics returns the `date` dimension as `YYYYMMDD`; the shared
 * records want ISO `YYYY-MM-DD`. Leave anything already ISO-shaped untouched.
 */
function normalizeDate(value: number | string | undefined): string {
  const raw = String(value ?? '').trim()
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(raw)
  if (match && match[1] && match[2] && match[3]) {
    return `${match[1]}-${match[2]}-${match[3]}`
  }
  return raw
}

function isMissingMonetaryScopeError(err: unknown): boolean {
  if (!(err instanceof YoutubeApiError)) return false
  if (err.status !== 400 && err.status !== 401 && err.status !== 403) return false
  const haystack = `${err.reason ?? ''} ${err.message}`.toLowerCase()
  return (
    haystack.includes('monetary') ||
    haystack.includes('yt-analytics-monetary') ||
    haystack.includes('estimatedrevenue') ||
    ((haystack.includes('not authorized') || haystack.includes('insufficient') || haystack.includes('permission')) &&
      haystack.includes('scope'))
  )
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
