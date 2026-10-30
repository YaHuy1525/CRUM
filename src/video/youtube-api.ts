// ── YouTube / Google APIs: thin HTTP client ─────────────────────────────────
//
// Pure network layer for the three Google endpoints the YouTube revenue adapter
// needs:
//   * YouTube Analytics API v2 (reports)  — earnings + audience metrics
//   * YouTube Data API v3 (channels)      — channel-level statistics
//   * Google OAuth2 token endpoint         — access-token refresh
//
// Deliberately dumb: it takes plain bearer tokens, knows nothing about the
// database or CRUM's at-rest encryption, and never touches `process.env`.
// Every network call goes through an injectable `fetch` (default the global
// `fetch`) so the whole client is testable with a fake transport.
//
// Scope notes (verified against the Google APIs):
//   * Monetary metrics (estimatedRevenue, estimatedAdRevenue, grossRevenue,
//     cpm, rpm) require `.../auth/yt-analytics-monetary.readonly`. Without that
//     scope the reports endpoint answers 401/403 (or omits the monetary
//     columns). Non-monetized channels legitimately return zero revenue.
//   * Activity metrics (views, estimatedMinutesWatched, subscribersGained,
//     subscribersLost) only need `.../auth/yt-analytics.readonly`.

const ANALYTICS_REPORTS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports'
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

// ---------------------------------------------------------------------------
// Config / error types
// ---------------------------------------------------------------------------

/** Injection point for the transport; supply a fake `fetch` in tests. */
export interface YoutubeApiConfig {
  fetch?: typeof fetch
}

/** Coarse classification of a failure so callers can branch without regex. */
export type YoutubeApiErrorKind = 'quota' | 'rateLimit' | 'auth' | 'http'

/**
 * Typed failure for every Google call. `status` mirrors the HTTP status and
 * `reason` carries Google's machine-readable error reason when present, so
 * callers can branch on `quotaExceeded` / `rateLimitExceeded` / `authError` (or
 * the missing-monetary-scope case) without string-matching the message.
 */
export class YoutubeApiError extends Error {
  readonly status: number
  readonly reason: string | undefined
  readonly kind: YoutubeApiErrorKind

  constructor(message: string, init: { status: number; reason?: string; kind?: YoutubeApiErrorKind }) {
    super(message)
    this.name = 'YoutubeApiError'
    this.status = init.status
    this.reason = init.reason
    this.kind = init.kind ?? classifyError(init.status, init.reason)
  }
}

function classifyError(status: number, reason?: string): YoutubeApiErrorKind {
  if (reason === 'quotaExceeded') return 'quota'
  if (reason === 'rateLimitExceeded') return 'rateLimit'
  if (status === 401 || status === 403 || reason === 'authError') return 'auth'
  return 'http'
}

// ---------------------------------------------------------------------------
// Google response envelopes (only the fields we consume)
// ---------------------------------------------------------------------------

interface GoogleColumnHeader {
  name: string
  columnType?: string
  dataType?: string
}

interface RawAnalyticsReport {
  columnHeaders?: GoogleColumnHeader[]
  rows?: unknown[][]
  rowCount?: number
}

/** Parsed analytics report: ordered column names plus object-shaped rows. */
export interface AnalyticsReport {
  columnNames: string[]
  rows: Record<string, number | string>[]
}

interface GoogleErrorDetail {
  reason?: string
  domain?: string
  message?: string
}

interface GoogleErrorBody {
  code?: number
  message?: string
  status?: string
  errors?: GoogleErrorDetail[]
}

interface GoogleErrorEnvelope {
  error?: GoogleErrorBody
}

interface RawChannelStatistics {
  subscriberCount?: string | number
  viewCount?: string | number
  videoCount?: string | number
}

interface RawChannelsResponse {
  items?: Array<{ id?: string; statistics?: RawChannelStatistics }>
}

interface TokenRefreshBody {
  access_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

export interface AnalyticsQueryParams {
  /** e.g. `channel==CHANNELID`. */
  ids: string
  startDate: string
  endDate: string
  metrics: string[]
  dimensions?: string[]
  sort?: string[]
  includeEmptyEntities?: boolean
  maxResults?: number
}

export interface ChannelStatistics {
  subscriberCount: number
  totalViews: number
  videoCount: number
}

export interface RefreshedAccessToken {
  /** The freshly-minted OAuth access token (Google rotates it on every call). */
  accessToken: string
  /** Seconds until expiry; 0 when the response omitted `expires_in`. */
  expiresIn: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a YouTube Analytics v2 report and return it with `rows` turned into
 * objects keyed by column name (metrics coerced to numbers).
 */
export async function queryAnalyticsReports(
  accessToken: string,
  params: AnalyticsQueryParams,
  config: YoutubeApiConfig = {},
): Promise<AnalyticsReport> {
  const search = new URLSearchParams()
  search.set('ids', params.ids)
  search.set('startDate', params.startDate)
  search.set('endDate', params.endDate)
  search.set('metrics', params.metrics.join(','))
  if (params.dimensions && params.dimensions.length > 0) {
    search.set('dimensions', params.dimensions.join(','))
  }
  if (params.sort && params.sort.length > 0) {
    search.set('sort', params.sort.join(','))
  }
  if (params.includeEmptyEntities) search.set('include-empty-entities', 'true')
  if (params.maxResults != null) search.set('max-results', String(params.maxResults))

  const url = `${ANALYTICS_REPORTS_URL}?${search.toString()}`
  const raw = await requestJson<RawAnalyticsReport>(url, accessToken, config)
  return parseAnalyticsReport(raw)
}

/**
 * Fetch the channel-level summary (subscriber count, total views, total video
 * count) from the YouTube Data API v3.
 */
export async function getChannelStatistics(
  channelId: string,
  accessToken: string,
  config: YoutubeApiConfig = {},
): Promise<ChannelStatistics> {
  const search = new URLSearchParams()
  search.set('part', 'statistics')
  search.set('id', channelId)

  const url = `${CHANNELS_URL}?${search.toString()}`
  const raw = await requestJson<RawChannelsResponse>(url, accessToken, config)
  const stats = raw.items?.[0]?.statistics

  return {
    subscriberCount: toNumber(stats?.subscriberCount),
    totalViews: toNumber(stats?.viewCount),
    videoCount: toNumber(stats?.videoCount),
  }
}

/**
 * Exchange a long-lived refresh token for a new access token via the Google
 * OAuth2 token endpoint. Google returns a fresh `access_token` but typically
 * does NOT rotate the `refresh_token`, so only the access token comes back.
 */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  config: YoutubeApiConfig = {},
): Promise<RefreshedAccessToken> {
  const body = new URLSearchParams()
  body.set('grant_type', 'refresh_token')
  body.set('client_id', clientId)
  body.set('client_secret', clientSecret)
  body.set('refresh_token', refreshToken)

  const doFetch = config.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    })
  } catch (err) {
    throw new YoutubeApiError(`YouTube token refresh request failed: ${messageOf(err)}`, {
      status: 0,
      kind: 'http',
    })
  }

  const text = await res.text()
  if (!res.ok) throw toApiError(res.status, text)

  const parsed = (text ? JSON.parse(text) : {}) as TokenRefreshBody
  if (parsed.error) {
    throw new YoutubeApiError(
      `YouTube token refresh rejected: ${parsed.error_description ?? parsed.error}`,
      { status: res.status, kind: 'auth' },
    )
  }
  if (!parsed.access_token) {
    throw new YoutubeApiError('YouTube token refresh response contained no access_token.', {
      status: res.status,
      kind: 'auth',
    })
  }

  return {
    accessToken: parsed.access_token,
    expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : 0,
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function requestJson<T>(url: string, accessToken: string, config: YoutubeApiConfig): Promise<T> {
  const doFetch = config.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    })
  } catch (err) {
    throw new YoutubeApiError(`YouTube request failed: ${messageOf(err)}`, { status: 0, kind: 'http' })
  }

  const text = await res.text()
  if (!res.ok) throw toApiError(res.status, text)
  return (text ? JSON.parse(text) : {}) as T
}

function toApiError(status: number, rawBody: string): YoutubeApiError {
  let reason: string | undefined
  let message = `YouTube API request failed with HTTP ${status}`
  try {
    const parsed = JSON.parse(rawBody) as GoogleErrorEnvelope
    const gerr = parsed.error
    if (gerr) {
      if (gerr.message) message = gerr.message
      reason = gerr.errors?.[0]?.reason ?? gerr.status ?? undefined
    }
  } catch {
    const trimmed = rawBody.trim()
    if (trimmed) message = `${message}: ${trimmed.slice(0, 300)}`
  }
  return new YoutubeApiError(`${message} (HTTP ${status})`, { status, reason })
}

function parseAnalyticsReport(raw: RawAnalyticsReport): AnalyticsReport {
  const headers = raw.columnHeaders ?? []
  const columnNames = headers.map((h) => h.name)
  const isNumeric = headers.map(isNumericColumn)

  const rows: Record<string, number | string>[] = (raw.rows ?? []).map((cells) => {
    const out: Record<string, number | string> = {}
    headers.forEach((_, i) => {
      const key = columnNames[i] ?? `column_${i}`
      const cell = cells[i]
      out[key] = isNumeric[i] ? toNumber(cell) : cellText(cell)
    })
    return out
  })

  return { columnNames, rows }
}

function isNumericColumn(header: GoogleColumnHeader): boolean {
  const dataType = (header.dataType ?? '').toUpperCase()
  if (dataType === 'INTEGER' || dataType === 'DOUBLE' || dataType === 'FLOAT') return true
  return (header.columnType ?? '').toUpperCase() === 'METRIC'
}

/** Coerce a Google cell (string, number, or null) to a finite number. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

/**
 * A text dimension cell as the row object should expose it. The analytics API
 * answers with `unknown[][]`, so this is the one place that decides what a cell
 * means: null/absent is an empty string, primitives render as their own text,
 * and the unexpected object/array shape is serialised rather than degrading to
 * "[object Object]" the way a bare String(cell) would.
 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value)
  }
  return JSON.stringify(value) ?? ''
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
