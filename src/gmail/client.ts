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

export const DEFAULT_REDIRECT_URI = 'http://localhost:4111/gmail/callback'

export const STATE_TTL_MS = 10 * 60 * 1000

export class GmailApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GmailApiError'
    this.status = status
  }
}

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
  watch?: boolean
}

export function resolvePool(pool?: Queryable): Queryable {
  return pool ?? getDbClient()
}


export function gmailRedirectUri(env: CrumEnv): string {
  return env.GMAIL_REDIRECT_URI ?? DEFAULT_REDIRECT_URI
}

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
    throw new GmailApiError('google returned no refresh token; reconnect with full consent', 400)
  }
  return { refreshToken: json.refresh_token, accessToken: json.access_token }
}


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
    `SELECT id, tenant_id, user_id, gmail_email, refresh_token_enc, scopes, watch
       FROM gmail_connections WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  )
  return (rows[0] as GmailConnectionRow | undefined) ?? null
}

export async function listWatchConnections(pool?: Queryable): Promise<GmailConnectionRow[]> {
  const { rows } = await resolvePool(pool).query(
    `SELECT id, tenant_id, user_id, gmail_email, refresh_token_enc, scopes, watch
       FROM gmail_connections WHERE watch = true ORDER BY tenant_id, user_id`,
    [],
  )
  return rows as GmailConnectionRow[]
}


type CachedToken = { accessToken: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>()

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
  tokenCache.set(key, {
    accessToken: json.access_token,
    expiresAt: Date.now() + Math.max(0, (json.expires_in ?? 3600) - 60) * 1000,
  })
  return json.access_token
}

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


/**
 * Sonar hotspot "API Traversal via unsanitized user input": the path mixes
 * fixed endpoints with caller-supplied search text (arrives only as
 * URLSearchParams-encoded values) and resource ids. Two chokepoints keep
 * every request pinned under GMAIL_API_ROOT: id segments are validated
 * before interpolation, and gmailFetch refuses any path containing
 * characters outside the endpoint/encoded-query alphabet, so no scheme,
 * `//host` override, `..` segment or backslash can ever reach fetch.
 */
const SAFE_PATH = /^\/[\w.~%/?&=,+@-]+$/
const SAFE_ID = /^[\w.~-]+$/

function pathId(id: string, kind: 'thread' | 'message'): string {
  if (!SAFE_ID.test(id) || id.includes('..')) {
    throw new GmailApiError(`gmail ${kind} id rejected by path policy`, 400)
  }
  return id
}

async function gmailFetch(accessToken: string, path: string, init?: RequestInit): Promise<Response> {
  if (!SAFE_PATH.test(path) || path.includes('//') || path.includes('..')) {
    throw new GmailApiError(`gmail request path rejected by policy: ${path.slice(0, 80)}`, 400)
  }
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
  const res = await gmailFetch(accessToken, '/profile')
  const json = (await res.json()) as { emailAddress?: string }
  if (!json.emailAddress) throw new GmailApiError('gmail profile returned no emailAddress', 500)
  return json.emailAddress
}

export interface ThreadSummary {
  id: string
  subject: string
  snippet: string
  senders: string[]
  date: string
}

interface GmailThread {
  id: string
  snippet?: string
  messages?: { payload?: { headers?: { name?: string; value?: string }[] } }[]
}

const SNIPPET_LIMIT = 500

function extractHeader(thread: GmailThread, name: string): string {
  const headers = thread.messages?.[0]?.payload?.headers ?? []
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
}

export async function searchThreadSummaries(
  accessToken: string,
  query: string,
  maxResults: number,
): Promise<ThreadSummary[]> {
  const listRes = await gmailFetch(
    accessToken,
    `/threads?${new URLSearchParams({ q: query, maxResults: String(maxResults) }).toString()}`,
  )
  const list = (await listRes.json()) as { threads?: { id: string }[] }
  const ids = (list.threads ?? []).map((t) => t.id)
  const details = await Promise.all(
    ids.map(async (id) => {
      const res = await gmailFetch(accessToken, `/threads/${pathId(id, 'thread')}?format=metadata&metadataInclude=From,Subject,Date`)
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
    date: extractHeader(thread, 'Date'),
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


export interface InboundMessage {
  id: string
  threadId: string
  subject: string
  senders: string[]
  recipients: string[]
  snippet: string
  date: string
  receivedAt: string
}

interface GmailMessage {
  id: string
  threadId: string
  snippet?: string
  internalDate?: string
  payload?: { headers?: { name?: string; value?: string }[] }
}

function messageHeader(message: GmailMessage, name: string): string {
  const headers = message.payload?.headers ?? []
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
}

export async function searchInboundMessages(
  accessToken: string,
  query: string,
  maxResults: number,
  pageToken?: string,
): Promise<{ messages: InboundMessage[]; nextPageToken?: string }> {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) })
  if (pageToken) params.set('pageToken', pageToken)
  const res = await gmailFetch(accessToken, `/messages?${params.toString()}`)
  const list = (await res.json()) as {
    messages?: { id: string; threadId: string }[]
    nextPageToken?: string
  }
  const ids = (list.messages ?? []).map((m) => m.id)
  const details = await Promise.all(
    ids.map(async (id) => {
      const r = await gmailFetch(accessToken, `/messages/${pathId(id, 'message')}?format=metadata&metadataInclude=From,To,Subject,Date`)
      return (await r.json()) as GmailMessage
    }),
  )
  return {
    messages: details.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      subject: messageHeader(m, 'Subject'),
      senders: messageHeader(m, 'From').split(',').map((s) => s.trim()).filter(Boolean),
      recipients: messageHeader(m, 'To').split(',').map((s) => s.trim()).filter(Boolean),
      snippet: (m.snippet ?? '').slice(0, SNIPPET_LIMIT),
      date: messageHeader(m, 'Date'),
      receivedAt: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date().toISOString(),
    })),
    ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}),
  }
}

export async function insertMailMessage(
  message: InboundMessage,
  owner: { tenantId: string; userId: string; gmailEmail: string },
  pool?: Queryable,
): Promise<boolean> {
  const { rows } = await resolvePool(pool).query(
    `INSERT INTO mail_messages
       (id, tenant_id, user_id, gmail_email, thread_id, subject, senders, recipients, snippet, date_header, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      message.id,
      owner.tenantId,
      owner.userId,
      owner.gmailEmail,
      message.threadId,
      message.subject,
      message.senders,
      message.recipients,
      message.snippet,
      message.date,
      message.receivedAt,
    ],
  )
  return rows.length > 0
}
