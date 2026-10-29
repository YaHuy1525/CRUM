// ── Twitch Helix + id.twitch.tv: thin HTTP client ──────────────────────────
//
// Pure network layer for the Twitch endpoints the audience-only revenue
// adapter needs:
//   * Helix Channels Followers API — `GET /helix/channels/followers` (total
//     follower count for a broadcaster)
//   * Helix Streams API            — `GET /helix/streams` (live channel
//     presence + current average concurrent `viewer_count`)
//   * Twitch OAuth2 token endpoint — `POST https://id.twitch.tv/oauth2/token`
//     (access-token refresh)
//
// Deliberately dumb: it takes plain bearer tokens, knows nothing about the
// database or CRUM's at-rest encryption, and never touches `process.env`.
// Every network call goes through an injectable `fetch` (default the global
// `fetch`) so the whole client is testable with a fake transport.
//
// Twitch-specific plumbing (verified against the Helix docs):
//   * EVERY Helix request must carry TWO headers: `Authorization: Bearer <token>`
//     AND `Client-Id: <client_id>`. A valid token from an unregistered client id
//     still fails, so `clientId` is a first-class parameter on every call here.
//   * The token endpoint lives on a different host (id.twitch.tv) and does NOT
//     use the Client-Id header — the client credentials travel in the
//     url-encoded form body instead.
//
// Scope notes (verified against the Twitch API):
//   * Twitch exposes NO revenue dollars anywhere in Helix. Payouts live only
//     in the private creator dashboard, so this client has no monetary surface
//     at all and the adapter is audience-only (`supportsRevenue = false`).
//   * Daily per-channel/per-video audience analytics (`GET /helix/analytics/
//     streams`) require the calling app to be a live Extension installed on
//     the channel and typically answer empty for normal creators. Only the
//     summary endpoints below are readable with a regular user token.

const HELIX_BASE_URL = 'https://api.twitch.tv/helix'
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'

// ---------------------------------------------------------------------------
// Config / error types
// ---------------------------------------------------------------------------

/** Injection point for the transport; supply a fake `fetch` in tests. */
export interface TwitchApiConfig {
  fetch?: typeof fetch
}

/** Coarse classification of a failure so callers can branch without regex. */
export type TwitchApiErrorKind = 'auth' | 'rateLimit' | 'notFound' | 'http'

/**
 * Typed failure for every Twitch call. `status` mirrors the HTTP status and
 * `reason` carries Twitch's machine-readable error label (`error` in both the
 * Helix `{ error, status, message }` envelope and the id.twitch.tv error body,
 * which is likewise HTTP-status driven) so callers can branch without
 * string-matching the message.
 */
export class TwitchApiError extends Error {
  readonly status: number
  readonly reason: string | undefined
  readonly kind: TwitchApiErrorKind

  constructor(message: string, init: { status: number; reason?: string; kind?: TwitchApiErrorKind }) {
    super(message)
    this.name = 'TwitchApiError'
    this.status = init.status
    this.reason = init.reason
    this.kind = init.kind ?? classifyError(init.status, init.reason)
  }
}

function classifyError(status: number, reason?: string): TwitchApiErrorKind {
  // Twitch labels errors with HTTP reason phrases ("Unauthorized",
  // "Not Found", ...); normalize away casing/spacing before matching.
  const normalized = (reason ?? '').toLowerCase().replace(/[^a-z]+/g, '')
  if (normalized === 'unauthorized' || normalized === 'forbidden') return 'auth'
  if (normalized === 'notfound') return 'notFound'
  if (normalized === 'toomanyrequests') return 'rateLimit'
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'notFound'
  if (status === 429) return 'rateLimit'
  return 'http'
}

// ---------------------------------------------------------------------------
// Twitch response envelopes (only the fields we consume)
// ---------------------------------------------------------------------------

/** Shared shape of Helix (`api.twitch.tv/helix`) and OAuth (`id.twitch.tv`) errors. */
interface TwitchErrorBody {
  error?: string
  status?: number
  message?: string
}

interface RawFollowersResponse {
  total?: number
  pagination?: { cursor?: string }
}

interface RawStream {
  id?: string
  user_id?: string
  user_name?: string
  game_name?: string
  title?: string
  viewer_count?: number
}

interface RawStreamsResponse {
  data?: RawStream[]
  pagination?: { cursor?: string }
}

/** A currently-live stream. Only the fields CRUM consumes are surfaced. */
export interface TwitchStreamInfo {
  id: string
  userId: string
  userName: string
  gameName: string
  title: string
  /** Average concurrent viewers over the last ~5 min; 0 when absent. */
  viewerCount: number
}

interface TokenResponseBody extends TwitchErrorBody {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  token_type?: string
}

export interface RefreshedTwitchToken {
  /** The freshly-minted OAuth access token. */
  accessToken: string
  /** Seconds until expiry; 0 when the response omitted `expires_in`. */
  expiresIn: number
  /**
   * Twitch DOES rotate the refresh token on every refresh — capture it here
   * when present so the caller can persist the replacement. Omitted when the
   * response did not include one.
   */
  refreshToken?: string
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Total follower count for a broadcaster via
 * `GET /helix/channels/followers?broadcaster_id={id}`.
 *
 * This endpoint answers `{ total, pagination }` — the full follower list
 * needs pagination walks and is not useful for the weekly sync, so only the
 * `total` is returned here. A response without `total` (should not happen for
 * a 200) is reported as 0 rather than thrown.
 */
export async function getFollowersTotal(
  broadcasterId: string,
  accessToken: string,
  clientId: string,
  config: TwitchApiConfig = {},
): Promise<number> {
  const search = new URLSearchParams()
  search.set('broadcaster_id', broadcasterId)

  const url = `${HELIX_BASE_URL}/channels/followers?${search.toString()}`
  const raw = await requestJson<RawFollowersResponse>(url, accessToken, clientId, config)
  return toNumber(raw.total)
}

/**
 * The broadcaster's currently-live stream via
 * `GET /helix/streams?user_id={id}`, or `null` when the channel is offline
 * (Helix answers `data: []` — the channel simply has no live stream).
 */
export async function getStream(
  broadcasterId: string,
  accessToken: string,
  clientId: string,
  config: TwitchApiConfig = {},
): Promise<TwitchStreamInfo | null> {
  const search = new URLSearchParams()
  search.set('user_id', broadcasterId)

  const url = `${HELIX_BASE_URL}/streams?${search.toString()}`
  const raw = await requestJson<RawStreamsResponse>(url, accessToken, clientId, config)
  const stream = raw.data?.[0]
  if (!stream) return null

  return {
    id: String(stream.id ?? ''),
    userId: String(stream.user_id ?? ''),
    userName: String(stream.user_name ?? ''),
    gameName: String(stream.game_name ?? ''),
    title: String(stream.title ?? ''),
    viewerCount: toNumber(stream.viewer_count),
  }
}

/**
 * Exchange a stored refresh token for a new access token via
 * `POST https://id.twitch.tv/oauth2/token` (url-encoded body, no Client-Id
 * header). Unlike Google, Twitch rotates BOTH tokens: the response carries a
 * fresh `refresh_token` alongside the `access_token`, so the caller must
 * persist whichever fields come back.
 */
export async function refreshTwitchAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  config: TwitchApiConfig = {},
): Promise<RefreshedTwitchToken> {
  const body = new URLSearchParams()
  body.set('client_id', clientId)
  body.set('client_secret', clientSecret)
  body.set('grant_type', 'refresh_token')
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
    throw new TwitchApiError(`Twitch token refresh request failed: ${messageOf(err)}`, {
      status: 0,
      kind: 'http',
    })
  }

  const text = await res.text()
  // id.twitch.tv token failures are HTTP-status driven: a 4xx here (bad
  // grant, revoked/rotated-away refresh token, wrong credentials) is always
  // an auth-class failure regardless of the body Twitch chooses to send.
  if (!res.ok) throw toApiError(res.status, text, res.status >= 400 && res.status < 500 ? 'auth' : undefined)

  const parsed = (text ? JSON.parse(text) : {}) as TokenResponseBody
  if (parsed.error) {
    throw new TwitchApiError(
      `Twitch token refresh rejected: ${parsed.message ?? parsed.error}`,
      { status: res.status, reason: parsed.error, kind: 'auth' },
    )
  }
  if (!parsed.access_token) {
    throw new TwitchApiError('Twitch token refresh response contained no access_token.', {
      status: res.status,
      kind: 'auth',
    })
  }

  const result: RefreshedTwitchToken = {
    accessToken: parsed.access_token,
    expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : 0,
  }
  if (typeof parsed.refresh_token === 'string' && parsed.refresh_token !== '') {
    result.refreshToken = parsed.refresh_token
  }
  return result
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * GET a Helix JSON document. Every Helix request sends BOTH the bearer token
 * and the `Client-Id` header — omitting either yields 401/403 no matter how
 * valid the other is.
 */
async function requestJson<T>(
  url: string,
  accessToken: string,
  clientId: string,
  config: TwitchApiConfig,
): Promise<T> {
  const doFetch = config.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': clientId,
        Accept: 'application/json',
      },
    })
  } catch (err) {
    throw new TwitchApiError(`Twitch request failed: ${messageOf(err)}`, { status: 0, kind: 'http' })
  }

  const text = await res.text()
  if (!res.ok) throw toApiError(res.status, text)
  return (text ? JSON.parse(text) : {}) as T
}

function toApiError(status: number, rawBody: string, forcedKind?: TwitchApiErrorKind): TwitchApiError {
  let reason: string | undefined
  let message = `Twitch API request failed with HTTP ${status}`
  try {
    const parsed = JSON.parse(rawBody) as TwitchErrorBody
    // Both Helix and id.twitch.tv embed `{ error, status, message }`.
    if (parsed.error || parsed.message) {
      if (parsed.message) message = parsed.message
      reason = parsed.error
    }
  } catch {
    const trimmed = rawBody.trim()
    if (trimmed) message = `${message}: ${trimmed.slice(0, 300)}`
  }
  return new TwitchApiError(`${message} (HTTP ${status})`, { status, reason, kind: forcedKind })
}

/** Coerce a Twitch cell (number, numeric string, or null/undefined) to a finite number. */
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
