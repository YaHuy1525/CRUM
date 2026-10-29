// ── TikTok Display API: thin HTTP client ────────────────────────────────────
//
// Pure network layer for the two TikTok endpoints the audience-only adapter
// needs:
//   * Display API v2 `video/query`  — the account's videos + their stats
//   * Display API v2 `oauth/token`  — access-token refresh (rotates the refresh
//     token on every grant)
//
// Deliberately dumb: it takes plain bearer tokens, knows nothing about the
// database or CRUM's at-rest encryption, and never touches `process.env`.
// Every network call goes through an injectable `fetch` (default the global
// `fetch`) so the whole client is testable with a fake transport.
//
// Capability notes (verified against the Display API):
//   * There is NO revenue/monetization endpoint and NO watch-time. The stats a
//     video exposes are `play_count`, `digg_count`, `comment_count`,
//     `share_count`. Followers live on `user/info`, not per video, and there is
//     no daily time series at all — `video/query` returns the account's current
//     videos with cumulative-to-date counters. Callers must treat these as a
//     single summary snapshot, not a date series.
//   * OAuth uses `client_key` (not `client_id`) plus `client_secret`, and the
//     token endpoint is `application/x-www-form-urlencoded`.

const VIDEO_QUERY_URL = 'https://open.tiktokapis.com/v2/video/query/'
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/'

/** `video/query` returns at most 20 videos per page. */
const DEFAULT_MAX_RESULTS = 20

/**
 * The `fields` projection. `video_id`+`stats.*` are what we consume; `title` is
 * requested because it is cheap and lets a future caller key rows without a
 * second round-trip, but the client itself ignores it.
 */
const VIDEO_QUERY_FIELDS =
  'video_id,title,stats.play_count,stats.digg_count,stats.comment_count,stats.share_count'

// ---------------------------------------------------------------------------
// Config / error types
// ---------------------------------------------------------------------------

/** Injection point for the transport; supply a fake `fetch` in tests. */
export interface TiktokApiConfig {
  fetch?: typeof fetch
}

/** Coarse classification of a failure so callers can branch without regex. */
export type TiktokApiErrorKind = 'auth' | 'rateLimit' | 'http'

/**
 * Typed failure for every TikTok call. `status` mirrors the HTTP status and
 * `reason` carries TikTok's machine-readable code (`error` string on the oauth
 * endpoint, `error.code` on the API host) when present, so callers can branch
 * without string-matching the message.
 */
export class TiktokApiError extends Error {
  readonly status: number
  readonly reason: string | undefined
  readonly kind: TiktokApiErrorKind

  constructor(message: string, init: { status: number; reason?: string; kind?: TiktokApiErrorKind }) {
    super(message)
    this.name = 'TiktokApiError'
    this.status = init.status
    this.reason = init.reason
    this.kind = init.kind ?? classifyError(init.status, init.reason)
  }
}

function classifyError(status: number, reason?: string): TiktokApiErrorKind {
  if (status === 429) return 'rateLimit'
  if (status === 401 || status === 403) return 'auth'
  if (reason) {
    const r = reason.toLowerCase()
    if (
      r.includes('token') ||
      r.includes('grant') ||
      r.includes('auth') ||
      r.includes('access_denied') ||
      r.includes('permission')
    ) {
      return 'auth'
    }
    if (r.includes('rate') || r.includes('limit') || r.includes('too_many') || r.includes('throttl')) {
      return 'rateLimit'
    }
  }
  return 'http'
}

// ---------------------------------------------------------------------------
// TikTok response envelopes (only the fields we consume)
// ---------------------------------------------------------------------------

interface RawVideoStats {
  play_count?: number | string
  digg_count?: number | string
  comment_count?: number | string
  share_count?: number | string
}

interface RawVideoItem {
  id?: string
  stats?: RawVideoStats
}

interface RawVideoQueryResponse {
  data?: {
    videos?: RawVideoItem[]
    cursor?: number | string
    has_more?: boolean
  }
}

/**
 * The two TikTok error shapes overlap, so `error` is typed as the union:
 *   * oauth endpoint → `error` is a string (`invalid_grant`) with a sibling
 *     `error_description` / `error_code`.
 *   * API host → `error` is an object `{ code, message }`.
 * We parse what we can and never overfit to a specific code list.
 */
interface TiktokErrorObject {
  code?: string
  suberror_code?: string
  message?: string
  log_id?: string
  request_id?: string
}

interface TiktokErrorEnvelope {
  error?: string | TiktokErrorObject
  error_description?: string
  error_code?: string | number
}

interface TokenRefreshBody {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  refresh_expires_in?: number
  scope?: string
  token_type?: string
  // oauth endpoint error fields (flat strings)
  error?: string | TiktokErrorObject
  error_description?: string
  error_code?: string | number
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** A single video's engagement counters, coerced to numbers. */
export interface TiktokVideoStat {
  videoId: string
  /** `stats.play_count` — the closest thing TikTok has to "views". */
  views: number
  /** `stats.digg_count` — likes. */
  likes: number
  /** `stats.comment_count` — comments. */
  comments: number
  /** `stats.share_count` — shares. */
  shares: number
}

export interface VideoQueryParams {
  /** Opaque `after_cursor` from a prior page's `data.cursor`; omit for page 1. */
  cursor?: number
  /** Page size; capped by TikTok at 20 (the default). */
  maxResults?: number
}

/** One page of `video/query`. `hasMore` mirrors `data.has_more`. */
export interface VideoQueryPage {
  videos: TiktokVideoStat[]
  cursor: number
  hasMore: boolean
}

export interface TiktokRefreshedToken {
  /** The freshly-minted OAuth access token. */
  accessToken: string
  /** Seconds until expiry; 0 when the response omitted `expires_in`. */
  expiresIn: number
  /**
   * TikTok ROTATES the refresh token on every grant. Present when the response
   * included a new `refresh_token` — callers MUST persist it, otherwise the next
   * refresh authenticates with a dead token. Absent when TikTok reused it.
   */
  refreshToken?: string
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch one page of the account's videos and their stats. Pagination is driven
 * by the caller: read `cursor`/`hasMore` off the returned page and pass
 * `cursor` back as `params.cursor` until `hasMore` is false.
 */
export async function queryVideos(
  accessToken: string,
  params: VideoQueryParams = {},
  config: TiktokApiConfig = {},
): Promise<VideoQueryPage> {
  const search = new URLSearchParams()
  search.set('fields', VIDEO_QUERY_FIELDS)
  const url = `${VIDEO_QUERY_URL}?${search.toString()}`

  const body: Record<string, unknown> = {
    filters: { deleted_video: false },
    max_results: params.maxResults ?? DEFAULT_MAX_RESULTS,
  }
  if (params.cursor != null && params.cursor > 0) {
    body.after_cursor = params.cursor
  }

  const raw = await requestJson<RawVideoQueryResponse>(url, accessToken, body, config)
  const data = raw.data ?? {}

  return {
    videos: (data.videos ?? []).map(toVideoStat),
    cursor: toNumber(data.cursor),
    hasMore: Boolean(data.has_more),
  }
}

/**
 * Exchange a stored refresh token for a new access token via the TikTok oauth
 * endpoint. Unlike Google, TikTok rotates the `refresh_token` too, so it is
 * surfaced as `refreshToken` when present.
 */
export async function refreshTiktokAccessToken(
  refreshToken: string,
  clientKey: string,
  clientSecret: string,
  config: TiktokApiConfig = {},
): Promise<TiktokRefreshedToken> {
  const body = new URLSearchParams()
  body.set('grant_type', 'refresh_token')
  body.set('client_key', clientKey)
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
    throw new TiktokApiError(`TikTok token refresh request failed: ${messageOf(err)}`, {
      status: 0,
      kind: 'http',
    })
  }

  const text = await res.text()
  if (!res.ok) throw toApiError(res.status, text)

  const parsed = (text ? JSON.parse(text) : {}) as TokenRefreshBody
  if (parsed.error) {
    // TikTok occasionally answers 200 with an error payload; treat it as auth.
    throw new TiktokApiError(
      `TikTok token refresh rejected: ${errorDetail(parsed.error, parsed.error_description)}`,
      { status: res.status, kind: 'auth' },
    )
  }
  if (!parsed.access_token) {
    throw new TiktokApiError('TikTok token refresh response contained no access_token.', {
      status: res.status,
      kind: 'auth',
    })
  }

  const result: TiktokRefreshedToken = {
    accessToken: parsed.access_token,
    expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : 0,
  }
  if (parsed.refresh_token) result.refreshToken = parsed.refresh_token
  return result
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function requestJson<T>(
  url: string,
  accessToken: string,
  body: unknown,
  config: TiktokApiConfig,
): Promise<T> {
  const doFetch = config.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new TiktokApiError(`TikTok request failed: ${messageOf(err)}`, { status: 0, kind: 'http' })
  }

  const text = await res.text()
  if (!res.ok) throw toApiError(res.status, text)
  return (text ? JSON.parse(text) : {}) as T
}

function toApiError(status: number, rawBody: string): TiktokApiError {
  let reason: string | undefined
  let message = `TikTok API request failed with HTTP ${status}`
  try {
    const parsed = JSON.parse(rawBody) as TiktokErrorEnvelope
    if (parsed.error != null) {
      message = errorDetail(parsed.error, parsed.error_description)
      reason = errorReason(parsed.error, parsed.error_code)
    }
  } catch {
    const trimmed = rawBody.trim()
    if (trimmed) message = `${message}: ${trimmed.slice(0, 300)}`
  }
  return new TiktokApiError(`${message} (HTTP ${status})`, { status, reason })
}

/** Flatten the two error shapes into a human-readable message. */
function errorDetail(error: string | TiktokErrorObject, description?: string): string {
  if (typeof error === 'string') return description ? `${error}: ${description}` : error
  return error.message || error.code || description || 'unknown error'
}

/** Best-effort machine code for `TiktokApiError.reason`. */
function errorReason(error: string | TiktokErrorObject, errorCode?: string | number): string | undefined {
  if (typeof error === 'string') {
    return errorCode != null ? String(errorCode) : error
  }
  return error.suberror_code ?? error.code
}

function toVideoStat(video: RawVideoItem): TiktokVideoStat {
  const stats = video.stats ?? {}
  return {
    videoId: String(video.id ?? ''),
    views: toNumber(stats.play_count),
    likes: toNumber(stats.digg_count),
    comments: toNumber(stats.comment_count),
    shares: toNumber(stats.share_count),
  }
}

/** Coerce a TikTok counter (number, decimal string, or null) to a finite number. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
