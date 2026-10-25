// src/gmail/client.ts
//
// The Gmail connector: OAuth consent URL building, code exchange, encrypted
// per-user token storage, access-token refresh with a process cache, and the
// thin REST surface the tools need (profile, thread search, draft create).
//
// Design notes:
//   - Refresh tokens are only ever read from / written to `gmail_connections`
//     through src/gmail/crypto.ts. Access tokens are short-lived and live in
//     this process's memory only (the migration comment records that rule).
//   - `access_type=offline` is mandatory: Google's authorization server only
//     issues a refresh token when the consent request carries it. `prompt=consent`
//     forces the approval screen so a re-connect reliably mints a NEW refresh
//     token instead of silently returning none.
//   - The pool is injectable (`Queryable`) so unit tests never open a socket,
//     mirroring how the db modules take a request context.
import { randomBytes } from 'node:crypto'
import type { CrumEnv } from '../config/env'
import { parseEnv } from '../config/env'
import { getDbClient } from '../db/client'
import { decryptRefreshToken, encryptRefreshToken, signState, verifyState } from './crypto'
import type { OAuthState } from './crypto'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me'

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
] as const

export const DEFAULT_REDIRECT_URI = 'http://localhost:4111/api/gmail/callback'

/** OAuth state lifetime: a consent round-trip that takes >10 minutes is abandoned. */
export const STATE_TTL_MS = 10 * 60 * 1000

export class GmailApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GmailApiError'
    this.status = status
  }
}

/** The subset of a pg pool this module needs; tests pass an object literal. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>
}

export interface GmailConnectionRow {
  id: string
  tenant_id: string
  user_id: string
  gmail_email: string
  refresh_token_enc: string
  scopes: string
}

export function resolvePool(pool?: Queryable): Queryable {
  return pool ?? (getDbClient() as unknown as Queryable)
}

// ── OAuth URL building and state ─────────────────────────────

export function gmailRedirectUri(env: CrumEnv): string {
  return env.GMAIL_REDIRECT_URI ?? DEFAULT_REDIRECT_URI
}

/** Returns null when the connector is not configured — callers answer 503. */
export function gmailOAuthConfigured(env: CrumEnv): { clientId: string; clientSecret: string; redirectUri: string } | null {
  if (!env.GMAIL_OAUTH_CLIENT_ID || !env.GMAIL_OAUTH_CLIENT_SECRET) return null
  return {
    clientId: env.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: env.GMAIL_OAUTH_CLIENT_SECRET,
    redirectUri: gmailRedirectUri(env),
  }
}

export function createState(tenantId: string, userId: string, secret: string): string {
  const payload: OAuthState = {
    tenantId,
    userId,
    exp: Date.now() + STATE_TTL_MS,
    nonce: randomBytes(12).toString('hex'),
  }
  return signState(payload, secret)
}

export const readState = verifyState

export function buildConsentUrl(
  creds: { clientId: string; redirectUri: string },
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: creds.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  })
  return `${GOOGLE_AUTH_URL}?${params.toString()}`
}

interface GoogleTokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

async function postTokenForm(form: URLSearchParams): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  const json = (await res.json().catch(() => ({}))) as GoogleTokenResponse
  if (!res.ok || json.error) {
    throw new GmailApiError(
      `google token endpoint rejected the request: ${json.error ?? `HTTP ${res.status}`} ${json.error_description ?? ''}`.trim(),
      res.status,
    )
  }
  return json
}

export async function exchangeCodeForTokens(
  creds: { clientId: string; clientSecret: string; redirectUri: string },
  code: string,
): Promise<{ refreshToken: string; accessToken: string }> {
  const json = await postTokenForm(
    new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: creds.redirectUri,
    }),
  )
  if (!json.refresh_token || !json.access_token) {
    // access_type=offline was set; a missing refresh token means the consent
    // did not grant it (revoked approval, or a policy block). Refuse to store.
    throw new GmailApiError('google returned no refresh token; reconnect with full consent', 400)
  }
  return { refreshToken: json.refresh_token, accessToken: json.access_token }
}

// ── Connection storage ───────────────────────────────────────

export async function saveConnection(
  input: { tenantId: string; userId: string; gmailEmail: string; refreshToken: string; scopes: string },
  pool?: Queryable,
): Promise<void> {
  const env = parseEnv()
  const secret = env.APPROVAL_HMAC_SECRET
  if (!secret) throw new GmailApiError('APPROVAL_HMAC_SECRET is unset; cannot encrypt the refresh token', 500)
  const enc = encryptRefreshToken(input.refreshToken, secret)
  await resolvePool(pool).query(
    `INSERT INTO gmail_connections (tenant_id, user_id, gmail_email, refresh_token_enc, scopes, connected_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (tenant_id, user_id)
     DO UPDATE SET gmail_email = EXCLUDED.gmail_email,
                   refresh_token_enc = EXCLUDED.refresh_token_enc,
                   scopes = EXCLUDED.scopes,
                   connected_at = now()`,
    [input.tenantId, input.userId, input.gmailEmail, enc, input.scopes],
  )
}

export async function loadConnection(
  tenantId: string,
  userId: string,
  pool?: Queryable,
): Promise<GmailConnectionRow | null> {
  const { rows } = await resolvePool(pool).query(
    `SELECT id, tenant_id, user_id, gmail_email, refresh_token_enc, scopes
       FROM gmail_connections WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  )
  return (rows[0] as GmailConnectionRow | undefined) ?? null
}

// ── Access-token cache + refresh ─────────────────────────────

type CachedToken = { accessToken: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>()

/** Drop cached tokens for a user (tests, disconnect flows). */
export function clearAccessTokenCache(tenantId: string, userId: string): void {
  tokenCache.delete(`${tenantId}:${userId}`)
}

export async function getAccessToken(
  row: GmailConnectionRow,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const key = `${row.tenant_id}:${row.user_id}`
  const cached = tokenCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken

  const env = parseEnv()
  const secret = env.APPROVAL_HMAC_SECRET
  if (!secret) throw new GmailApiError('APPROVAL_HMAC_SECRET is unset; cannot decrypt the refresh token', 500)
  const refreshToken = decryptRefreshToken(row.refresh_token_enc, secret)

  const json = await postTokenForm(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  )
  if (!json.access_token) throw new GmailApiError('google returned no access token', 500)
  // Refresh 60 s early so an in-flight request never uses a boundary-expired token.
  tokenCache.set(key, {
    accessToken: json.access_token,
    expiresAt: Date.now() + Math.max(0, (json.expires_in ?? 3600) - 60) * 1000,
  })
  return json.access_token
}

/**
 * Report whether a user's mailbox is connected AND usable. Used by the mail
 * tools and routes; a missing connection is a normal state, not an error.
 */
export async function resolveGmailAccess(
  env: CrumEnv,
  tenantId: string,
  userId: string,
): Promise<{ ok: true; accessToken: string; email: string } | { ok: false; reason: string }> {
  const creds = gmailOAuthConfigured(env)
  if (!creds) return { ok: false, reason: 'Gmail connector not configured' }
  if (!env.DATABASE_URL) return { ok: false, reason: 'Gmail needs persistent storage (DATABASE_URL unset)' }
  let row
  try {
    row = await loadConnection(tenantId, userId)
  } catch (err) {
    return { ok: false, reason: `connection lookup failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!row) return { ok: false, reason: 'no Gmail mailbox is connected for this user' }
  try {
    const accessToken = await getAccessToken(row, creds.clientId, creds.clientSecret)
    return { ok: true, accessToken, email: row.gmail_email }
  } catch (err) {
    return { ok: false, reason: `token refresh failed (reconnect required): ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ── Gmail REST surface ───────────────────────────────────────

async function gmailFetch(accessToken: string, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${GMAIL_API_ROOT}${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new GmailApiError(`gmail api ${path} failed: HTTP ${res.status} ${body.slice(0, 200)}`, res.status)
  }
  return res
}

export async function fetchProfileEmail(accessToken: string): Promise<string> {
  const res = await gmailFetch(accessToken, '')
  const json = (await res.json()) as { emailAddress?: string }
  if (!json.emailAddress) throw new GmailApiError('gmail profile returned no emailAddress', 500)
  return json.emailAddress
}

export interface ThreadSummary {
  id: string
  subject: string
  snippet: string
  senders: string[]
}

interface GmailThread {
  id: string
  snippet?: string
  messages?: { part?: { headers?: { name?: string; value?: string }[] } }[]
}

/** Snippets are attacker-controlled text (email bodies). Cap them hard. */
const SNIPPET_LIMIT = 500

function extractHeader(thread: GmailThread, name: string): string {
  const headers = thread.messages?.[0]?.part?.headers ?? []
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
}

export async function searchThreadSummaries(
  accessToken: string,
  query: string,
  maxResults: number,
): Promise<ThreadSummary[]> {
  const listRes = await gmailFetch(
    accessToken,
    `/threads?${new URLSearchParams({ q: query, maxResults: String(maxResults) })}`,
  )
  const list = (await listRes.json()) as { threads?: { id: string }[] }
  const ids = (list.threads ?? []).map((t) => t.id)
  const details = await Promise.all(
    ids.map(async (id) => {
      const res = await gmailFetch(accessToken, `/threads/${id}?format=metadata&metadataInclude=From,Subject,Date`)
      return (await res.json()) as GmailThread
    }),
  )
  return details.map((thread) => ({
    id: thread.id,
    subject: extractHeader(thread, 'Subject'),
    snippet: (thread.snippet ?? '').slice(0, SNIPPET_LIMIT),
    senders: extractHeader(thread, 'From')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }))
}

function encodeRfc2822(message: { to: string; subject: string; body: string }): string {
  const lines = [
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    message.body,
  ]
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
}

export async function createGmailDraft(
  accessToken: string,
  message: { to: string; subject: string; body: string },
): Promise<{ id: string }> {
  const res = await gmailFetch(accessToken, '/drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw: encodeRfc2822(message) } }),
  })
  const json = (await res.json()) as { id?: string }
  if (!json.id) throw new GmailApiError('gmail drafts.create returned no id', 500)
  return { id: json.id }
}
