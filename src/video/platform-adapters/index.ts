/**
 * Platform adapter interface for video revenue tracking.
 *
 * Each supported platform (YouTube, TikTok, Instagram, Twitch) implements this
 * interface to provide earnings data, audience metrics, and OAuth token refresh.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface DateRange {
  start: string // ISO-8601 date (YYYY-MM-DD)
  end: string // ISO-8601 date (YYYY-MM-DD)
}

export interface EarningsRecord {
  date: string // ISO-8601 date
  revenue_micros: number
  currency: string
  impressions: number
  estimated_revenue: number
}

export interface EarningsData {
  channelId: string
  platform: string
  dateRange: DateRange
  records: EarningsRecord[]
  fetchedAt: string // ISO-8601 timestamp
}

export interface AudienceRecord {
  date: string // ISO-8601 date
  views: number
  watchTimeMinutes: number
  subscribersGained: number
  subscribersLost: number
  likes: number
  comments: number
  shares: number
}

export interface AudienceData {
  channelId: string
  platform: string
  dateRange: DateRange
  records: AudienceRecord[]
  fetchedAt: string // ISO-8601 timestamp
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface PlatformAdapter {
  /** Human-readable platform name (e.g. "youtube", "tiktok"). */
  readonly platform: string

  /**
   * Whether this platform exposes monetization/revenue figures through its
   * public API. YouTube does (via the yt-analytics-monetary scope); TikTok,
   * Instagram, and Twitch do not — their payout data lives only in the private
   * creator dashboards. The daily earnings sync skips adapters that report
   * `false` here, so it does not log an error for platforms that structurally
   * cannot provide the data. Sponsorship revenue for these platforms is
   * captured through the Phase 4 email-intake path instead.
   */
  readonly supportsRevenue: boolean

  /**
   * Whether this platform exposes audience/engagement metrics. True for all
   * four currently supported platforms. The weekly audience sync skips
   * adapters that report `false`.
   */
  readonly supportsAudienceMetrics: boolean

  /**
   * Fetch earnings data for a channel over the given date range.
   * Results should be stored by the caller into `video_earnings`.
   * Only call this when {@link supportsRevenue} is true.
   */
  fetchEarnings(channelId: string, dateRange: DateRange): Promise<EarningsData>

  /**
   * Fetch audience metrics for a channel over the given date range.
   * Results should be stored by the caller into `video_audience_metrics`.
   * Only call this when {@link supportsAudienceMetrics} is true.
   */
  fetchAudienceMetrics(channelId: string, dateRange: DateRange): Promise<AudienceData>

  /**
   * Refresh an expired OAuth token. Implementations should update the token
   * row in the database so subsequent API calls succeed.
   */
  refreshOAuthToken(tokenId: string): Promise<void>
}
