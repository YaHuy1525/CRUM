// ── Instagram (Meta Graph API): thin HTTP client ────────────────────────────
//
// Pure network layer for the two Graph endpoints the Instagram audience adapter
// needs, on the "Instagram API with Instagram Login" surface (this is the flow
// already configured in src/api/video-oauth.ts via
// `https://api.instagram.com/oauth/authorize`):
//   * GET https://graph.instagram.com/me/media       — media objects + inline insights
//   * GET https://graph.instagram.com/refresh_access_token — access-token rotation
//
// Deliberately dumb: it takes plain bearer tokens, knows nothing about the
// database or CRUM's at-rest encryption, and never touches `process.env`.
// Every network call goes through an injectable `fetch` (default the global
// `fetch`) so the whole client is testable with a fake transport.
//
// Scope notes (verified against the Instagram API with Instagram Login):
//   * Instagram exposes NO revenue dollars through any public API. The metrics
//     available here are engagement-side only: video_views (views),
//     like_count, comment_count, share_count, plus the insights metrics
//     engagement / impressions / reach. There is no watch-time metric and no
//     follower-delta metric on this endpoint, so callers map those to zero.
//   * Token refresh differs from the classic Google/YouTube flow: there is NO
//     long-lived `refresh_token`. `refresh_access_token?grant_type=ig_refresh_token`
//     is called with the CURRENT ACCESS TOKEN and returns a new access token
//     (~2h for a short-lived input; 60-day tokens are rotated the same way).

const GRAPH_HOST = 'https://graph.instagram.com'
const MEDIA_LIST_URL = `${GRAPH_HOST}/me/media`
const REFRESH_TOKEN_URL = `${GRAPH_HOST}/refresh_access_token`

/**
 * Default field set for the media objects query: the counters live directly on
 * the media object; the insight metrics come back inline via the
 * `insights.metric(...)` pseudo-field (no separate per-media /insights call).
 */
export const DEFAULT_MEDIA_FIELDS =
  'id,timestamp,like_count,comment_count,video_views,share_count,insights.metric(engagement,impressions,reach)'

/** Hard stop for cursor pagination so a malformed `paging.next` chain cannot loop forever. */
const MAX_PAGES = 100

// ---------------------------------------------------------------------------
// Config / error types
// ---------------------------------------------------------------------------

/** Injection point for the transport; supply a fake `fetch` in tests. */
export interface InstagramApiConfig {
  fetch?: typeof fetch
}

/** Coarse classification of a failure so callers can branch without regex. */
export type InstagramApiErrorKind = 'rateLimit' | 'auth' | 'http'

/**
 * Typed failure for every Graph call. `status` mirrors the HTTP status and
 * `reason` carries Meta's machine-readable error identity when present,
 * composed as `${type}:${code}` (e.g. `OAuthException:190` for an expired or
 * invalid token, `OAuthException:4` for throttling), so callers can branch
 * without string-matching the human message.
 */
export class InstagramApiError extends Error {
  readonly status: number
  readonly reason: string | undefined
  readonly kind: InstagramApiErrorKind

  constructor(
    message: string,
    init: { status: number; reason?: string; kind?: InstagramApiErrorKind },
  ) {
    super(message)
    this.name = 'InstagramApiError'
    this.status = init.status
    this.reason = init.reason
    this.kind = init.kind ?? classifyError(init.status, init.reason)
  }
}

function classifyError(status: number, reason?: string): InstagramApiErrorKind {
  if (status === 429) return 'rateLimit'
  if (reason) {
    if (/(^|:)(4|17|32|613)($|:)/.test(reason)) return 'rateLimit'
    if (/(^|:)(190|102)($|:)/.test(reason) || reason.includes('OAuthException')) return 'auth'
  }
  if (status === 401 || status === 403) return 'auth'
  return 'http'
}

// ---------------------------------------------------------------------------
// Meta response envelopes (only the fields we consume)
// ---------------------------------------------------------------------------

/**
 * Meta error bodies look like `{ error: { message, type, code, fbtrace_id } }`
 * (legacy endpoints occasionally send `error` as a bare string).
 */
interface MetaErrorDetail {
  message?: string
  type?: string
  code?: number | string
  error_subcode?: number | string
  fbtrace_id?: string
}

interface MetaErrorEnvelope {
  error?: MetaErrorDetail | string
}

interface RawInsightValue {
  value?: unknown
  end_time?: string
}

interface RawInsightEntry {
  name?: string
  values?: RawInsightValue[]
  title?: string
}

interface RawInstagramMedia {
  id?: string
  timestamp?: string
  video_views?: number | string
  like_count?: number | string
  comment_count?: number | string
  share_count?: number | string
  insights?: { data?: RawInsightEntry[] }
}

interface RawPaging {
  next?: string
  previous?: string
  cursors?: { before?: string; after?: string }
}

interface RawMediaListResponse {
  data?: RawInstagramMedia[]
  paging?: RawPaging
}

interface InstagramRefreshBody {
  access_token?: string
  expires_in?: number
  error?: MetaErrorDetail | string
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * One Instagram media object with its counters flattened. Field names mirror
 * the Graph API (`video_views`, `like_count`, …) so adapter mapping stays
 * obvious. `engagement`/`impressions`/`reach` are only present when Meta
 * actually returned the inline insight entry for that media.
 */
export interface InstagramMediaObject {
  id: string
  timestamp: string
  video_views: number
  like_count: number
  comment_count: number
  share_count: number
  engagement?: number
  impressions?: number
  reach?: number
}

export interface MediaInsightsQueryParams {
  /**
   * Lower bound for media creation time. ISO date/datetime strings are
   * converted to the UNIX seconds Meta expects; plain numbers pass through.
   */
  since?: string | number
  /** Upper bound for media creation time; same normalization as `since`. */
  until?: string | number
  /** Page size for each request; Meta defaults to a smaller window otherwise. */
  limit?: number
  /** Override the default Graph field set (advanced use / testing). */
  fields?: string
}

export interface RefreshedInstagramAccessToken {
  /** The freshly-minted access token returned by `refresh_access_token`. */
  accessToken: string
  /** Seconds until expiry; 0 when the response omitted `expires_in`. */
  expiresIn: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pull the account's media objects (with inline engagement insights) from
 * `GET /me/media`, transparently following `paging.next` until the chain ends
 * (or MAX_PAGES is exceeded). Returns them flattened to
 * {@link InstagramMediaObject}s; date filtering/bucketing is the adapter's job.
 */
export async function getMediaWithInsights(
  accessToken: string,
  params: MediaInsightsQueryParams = {},
  config: InstagramApiConfig = {},
): Promise<InstagramMediaObject[]> {
  let url: string | undefined = buildMediaListUrl(params)
  const out: InstagramMediaObject[] = []

  for (let page = 0; url != null; page++) {
    if (page >= MAX_PAGES) {
      throw new InstagramApiError(
        `Instagram media pagination exceeded ${MAX_PAGES} pages; aborting.`,
        { status: 0, kind: 'http' },
      )
    }
    const raw: RawMediaListResponse = await requestJson<RawMediaListResponse>(url, accessToken, config)
    for (const media of raw.data ?? []) {
      out.push(parseMedia(media))
    }
    // Meta hands back a fully-formed `next` URL (it embeds the access token and
    // the `after` cursor); fetch it verbatim with the same bearer header.
    url = raw.paging?.next
  }

  return out
}

/**
 * Rotate an Instagram access token via
 * `GET /refresh_access_token?grant_type=ig_refresh_token`.
 *
 * IMPORTANT: unlike Google/YouTube, the "Instagram API with Instagram Login"
 * surface has NO refresh_token. The credential you refresh with is the CURRENT
 * ACCESS TOKEN itself (`accessToken` here); Meta answers with a brand-new
 * access token and `expires_in`. `clientKey`/`clientSecret` are the Instagram
 * app credentials and are sent alongside for app identity validation.
 */
export async function refreshInstagramAccessToken(
  accessToken: string,
  clientKey: string,
  clientSecret: string,
  config: InstagramApiConfig = {},
): Promise<RefreshedInstagramAccessToken> {
  const search = new URLSearchParams()
  search.set('grant_type', 'ig_refresh_token')
  search.set('access_token', accessToken)
  search.set('client_id', clientKey)
  search.set('client_secret', clientSecret)

  const doFetch = config.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(`${REFRESH_TOKEN_URL}?${search.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
  } catch (err) {
    throw new InstagramApiError(`Instagram token refresh request failed: ${messageOf(err)}`, {
      status: 0,
      kind: 'http',
    })
  }

  const text = await res.text()
  if (!res.ok) throw toApiError(res.status, text)

  const parsed = (text ? JSON.parse(text) : {}) as InstagramRefreshBody
  if (parsed.error) {
    throw new InstagramApiError(`Instagram token refresh rejected: ${describeMetaError(parsed.error)}`, {
      status: res.status,
      kind: 'auth',
      reason: composeReason(parsed.error),
    })
  }
  if (!parsed.access_token) {
    throw new InstagramApiError('Instagram token refresh response contained no access_token.', {
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

function buildMediaListUrl(params: MediaInsightsQueryParams): string {
  const search = new URLSearchParams()
  search.set('fields', params.fields ?? DEFAULT_MEDIA_FIELDS)
  search.set('limit', String(params.limit ?? 100))
  if (params.since != null) search.set('since', toEpochSeconds(params.since, 'since'))
  if (params.until != null) search.set('until', toEpochSeconds(params.until, 'until'))
  return `${MEDIA_LIST_URL}?${search.toString()}`
}

/** Meta's `since`/`until` are UNIX seconds; normalize ISO strings, pass numbers through. */
function toEpochSeconds(value: string | number, label: 'since' | 'until'): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidTimeFilter(label, String(value))
    return String(Math.floor(value))
  }
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return trimmed
  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms)) throw invalidTimeFilter(label, value)
  return String(Math.floor(ms / 1000))
}

function invalidTimeFilter(label: 'since' | 'until', value: string): InstagramApiError {
  return new InstagramApiError(`Instagram media query has an unparseable "${label}" value: ${value}`, {
    status: 0,
    kind: 'http',
  })
}

async function requestJson<T>(url: string, accessToken: string, config: InstagramApiConfig): Promise<T> {
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
    throw new InstagramApiError(`Instagram request failed: ${messageOf(err)}`, { status: 0, kind: 'http' })
  }

  const text = await res.text()
  if (!res.ok) throw toApiError(res.status, text)
  return (text ? JSON.parse(text) : {}) as T
}

function toApiError(status: number, rawBody: string): InstagramApiError {
  let message = `Instagram Graph API request failed with HTTP ${status}`
  let reason: string | undefined
  try {
    const parsed = JSON.parse(rawBody) as MetaErrorEnvelope
    const meta = typeof parsed.error === 'object' ? parsed.error : undefined
    if (meta) {
      message = meta.message ?? message
      reason = composeReason(meta)
    } else if (typeof parsed.error === 'string') {
      message = parsed.error
    }
  } catch {
    const trimmed = rawBody.trim()
    if (trimmed) message = `${message}: ${trimmed.slice(0, 300)}`
  }
  return new InstagramApiError(`${message} (HTTP ${status})`, { status, reason })
}

/** `OAuthException:190` when both parts are known; falls back to whichever exists. */
function composeReason(error: MetaErrorDetail | string): string | undefined {
  if (typeof error === 'string') return undefined
  const type = error.type?.trim()
  const code = error.code == null ? undefined : String(error.code).trim()
  if (type && code) return `${type}:${code}`
  if (type) return type
  if (code) return `code:${code}`
  return undefined
}

function describeMetaError(error: MetaErrorDetail | string): string {
  if (typeof error === 'string') return error
  const detail = [error.message, error.type && error.code ? `${error.type} (${error.code})` : error.type]
    .filter(Boolean)
    .join(' — ')
  return detail || 'unknown Meta error'
}

function parseMedia(raw: RawInstagramMedia): InstagramMediaObject {
  return {
    id: String(raw.id ?? ''),
    timestamp: String(raw.timestamp ?? ''),
    video_views: toNumber(raw.video_views),
    like_count: toNumber(raw.like_count),
    comment_count: toNumber(raw.comment_count),
    share_count: toNumber(raw.share_count),
    ...flattenInsights(raw),
  }
}

/**
 * Flatten `insights.data` entries (engagement/impressions/reach) onto the media
 * object. Each metric carries a `values` time-series; we take the LAST value as
 * the lifetime total. Any other insight metric names are ignored.
 */
function flattenInsights(raw: RawInstagramMedia): Partial<InstagramMediaObject> {
  const out: Partial<InstagramMediaObject> = {}
  for (const entry of raw.insights?.data ?? []) {
    const name = entry?.name
    if (name !== 'engagement' && name !== 'impressions' && name !== 'reach') continue
    const values = entry.values ?? []
    const latest = values[values.length - 1]
    out[name] = toNumber(latest?.value)
  }
  return out
}

/** Coerce a Graph counter (number, decimal string, or null) to a finite number. */
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
