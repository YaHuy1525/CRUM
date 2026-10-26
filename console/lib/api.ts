// console/lib/api.ts
/**
 * The console's only way to the REST plane. §10.2, §13.2.
 *
 * Two reasons this exists instead of `fetch()` calls scattered through the
 * components:
 *
 * 1. **Errors have to arrive.** The plane answers a misconfiguration with a body
 *    (`{error, detail}` / `{error, reason}`) and a status, and the old components
 *    did `.then(r => r.json())` with a `.catch()` that swallowed to an empty list.
 *    A developer with no dev identity set then saw "No pending approvals." — the
 *    most misleading possible result, because the queue was not empty, it was
 *    never read. Everything here throws, and the callers render the message.
 * 2. **No identity in the browser.** Nothing in this file sets `x-tenant-id` or
 *    any other claim; `console/middleware.ts` attaches them server-side. A client
 *    that could name a tenant is a client that can read one.
 */

import type {
  CrmContact,
  CrmFollowup,
  CrmListResponse,
  CrmSchedule,
  CrmTask,
  CustomerRow,
  DigestResponse,
  QueueResponse,
  SearchResponse,
  ThreadMessagesResponse,
  ThreadRow,
  ThreadsResponse,
} from './types'

/** A failed plane call, carrying what the plane actually said. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly detail?: string

  constructor(status: number, code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

/**
 * Shape shared by the plane's failures. `reason` is the 401 vocabulary from
 * `resolveIdentity`, `detail` is the human sentence from the query/validation
 * guards, and the middleware's own refusals use the same two keys.
 */
function errorFromBody(status: number, body: unknown): ApiError {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const code =
      typeof record.error === 'string'
        ? record.error
        : typeof record.detail === 'string'
          ? 'request_failed'
          : 'unknown_error'
    const detail =
      typeof record.detail === 'string'
        ? record.detail
        : Array.isArray(record.issues)
          ? record.issues.join('; ')
          : undefined
    // A 401 carries `reason` rather than `detail`, and the reason is the useful
    // half: 'missing-claim' and 'invalid-claim' point at different mistakes.
    if (code === 'unauthorized' && typeof record.reason === 'string') {
      return new ApiError(status, code, `identity rejected (${record.reason})`)
    }
    return new ApiError(status, code, detail)
  }
  return new ApiError(status, 'request_failed', `HTTP ${status}`)
}

/**
 * The one sentence for "this request never reached a plane that could answer in its
 * own vocabulary". `status` is 0 when `fetch` itself threw and the proxy's own status
 * when the proxy answered instead; either way the panel has to say which port to go
 * and check, because that is the only actionable fact a browser-side caller has.
 */
function planeUnreachable(path: string, status: number, cause: string): ApiError {
  return new ApiError(
    status,
    'network_unreachable',
    `Could not reach ${path.split('/').slice(0, 3).join('/')}. Is the server on :4113 (REST) / :4111 (chat) running? (${cause})`,
  )
}

/**
 * One GET/POST/DELETE round trip, JSON in and out, with failures thrown rather
 * than returned. A non-2xx response is parsed for its body first, because the
 * plane's error bodies are the diagnosis.
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      // Merged, not replaced: callers add request-scoped headers (`x-session-id` on
      // a signal), and a spread that put `Accept` last would silently drop them and
      // arrive as a 400 'header required' from the plane.
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers as Record<string, string> | undefined ?? {}),
      },
    })
  } catch (err) {
    // The rewrite target was down, so Next returned a connection failure rather
    // than a status. Naming the plane is what makes this debuggable from a browser.
    throw planeUnreachable(path, 0, err instanceof Error ? err.message : String(err))
  }

  // 204 has no body; everything else is read as text and then parsed, so a plane
  // that answers in something other than JSON still produces a readable message
  // instead of a `JSON.parse` throw inside a `.then`.
  if (response.status === 204) return undefined as T

  const text = await response.text()
  let parsed: unknown = null
  let answeredInJson = false
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
      answeredInJson = true
    } catch {
      parsed = { detail: text.slice(0, 300) }
    }
  }

  if (!response.ok) {
    // A 5xx with a body that is not JSON was not written by the plane. `src/api/serve.ts`
    // installs `app.onError` and `app.notFound` precisely so that a thrown route and an
    // unmatched path both still answer as JSON; the only other writer of a plain-text 500
    // on this path is the Next rewrite proxy in `next.config.js`, which produces it when
    // nothing is listening on the upstream port. Reporting that as
    // `request_failed (500): Internal Server Error` tells the operator to go debug a
    // server that is not even running, so it keeps the unreachable vocabulary.
    if (!answeredInJson && text.length > 0 && response.status >= 500) {
      throw planeUnreachable(path, response.status, `proxy answered HTTP ${response.status} ${text.slice(0, 80).trim()}`)
    }
    throw errorFromBody(response.status, parsed)
  }
  return parsed as T
}

export const get = <T>(path: string): Promise<T> => request<T>(path, { method: 'GET' })
export const post = <T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(headers ? { headers } : {}),
  })
export const patch = <T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> =>
  request<T>(path, {
    method: 'PATCH',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(headers ? { headers } : {}),
  })
export const del = <T>(path: string, headers?: Record<string, string>): Promise<T> =>
  request<T>(path, { method: 'DELETE', ...(headers ? { headers } : {}) })

/**
 * Turn a thrown value into the sentence a panel should show. Non-`ApiError`
 * throws (a bug, not a server answer) keep their own text rather than being
 * relabelled as a server failure.
 */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 503 && err.code === 'identity-not-configured') {
      return `${err.detail ?? err.code} — set the console's dev identity and restart \`next dev\`.`
    }
    return err.detail ? `${err.code} (${err.status || 'no response'}): ${err.detail}` : `${err.code} (${err.status || 'no response'})`
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * Typed clients for the Chats section's conversation plane (`src/api/threads.ts`).
 *
 * Every one goes through `request`, so a 404 arrives as a thrown `ApiError`
 * with `code === 'not_found'` (the caller decides whether that is a redirect or
 * a banner), a 503 wiring fault keeps its `agent-not-wired` / `memory-not-wired`
 * code, and nothing here attaches an identity header — `middleware.ts` injects
 * identity server-side, and a client that named a tenant could read one.
 */

/** `GET /api/agent/threads` — the caller's own conversations, newest first. The
 *  resource is derived server-side from the verified identity; there is no query
 *  parameter for it, and this client never sends one. */
export const listThreads = (): Promise<ThreadsResponse> =>
  get<ThreadsResponse>('/api/agent/threads')

/** `GET /api/agent/threads/:id` — metadata and existence check. 404 `not_found`
 *  for a missing id or one owned by another user (deliberately indistinguishable). */
export const getThread = (id: string): Promise<ThreadRow> =>
  get<ThreadRow>(`/api/agent/threads/${encodeURIComponent(id)}`)

/** `GET /api/agent/threads/:id/messages` — one page of the stored transcript. */
export const getThreadMessages = (
  id: string,
  page = 1,
  perPage = 50,
): Promise<ThreadMessagesResponse> =>
  get<ThreadMessagesResponse>(
    `/api/agent/threads/${encodeURIComponent(id)}/messages?page=${page}&perPage=${perPage}`,
  )

/**
 * `PATCH /api/agent/threads/:id` with `source: 'user'` — a manual rename. The
 * plane pins the title so a later auto-title never overwrites it, and rejects an
 * empty title with 400 `invalid_title`.
 */
export const renameThread = (id: string, title: string): Promise<ThreadRow> =>
  patch<ThreadRow>(`/api/agent/threads/${encodeURIComponent(id)}`, { title, source: 'user' })

/**
 * `PATCH /api/agent/threads/:id` with `source: 'auto'` — the launch view's
 * first-turn title. Applies only when the stored title is empty and unpinned;
 * otherwise the plane is a no-op and the current title stands.
 */
export const autoTitleThread = (id: string, title: string): Promise<ThreadRow> =>
  patch<ThreadRow>(`/api/agent/threads/${encodeURIComponent(id)}`, { title, source: 'auto' })

/** `DELETE /api/agent/threads/:id` — deletes the thread and its messages. */
export const deleteThread = (id: string): Promise<{ ok: boolean; id: string }> =>
  del<{ ok: boolean; id: string }>(`/api/agent/threads/${encodeURIComponent(id)}`)

/** `GET /api/agent/search?query=` — semantic search over the caller's threads. */
export const searchThreads = (query: string): Promise<SearchResponse> =>
  get<SearchResponse>(`/api/agent/search?query=${encodeURIComponent(query)}`)

/**
 * Typed clients for the CRM read surface (`src/api/crm.ts`).
 *
 * These are the console's only way to the Records lists and to the dashboard
 * cards. They are read only on purpose: every CRM mutation goes through the
 * agent's staging plus the approval queue, so there is no `create`/`update`
 * sibling here to be tempted by.
 */

/**
 * Serialise only the keys a caller set. An empty string is dropped rather than
 * sent as `name=`: the plane treats a present-but-empty filter as its own value,
 * and an `ILIKE '%%'` is not the same request as no filter at all once someone
 * adds an index or a stricter parser.
 */
function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const serialised = search.toString()
  return serialised ? `?${serialised}` : ''
}

/** `GET /api/crm/customers` — paged, with name/city/tags filters. */
export const listCustomers = (
  params: {
    limit?: number
    offset?: number
    name?: string
    city?: string
    tags?: string[]
  } = {},
): Promise<CrmListResponse<CustomerRow>> =>
  get<CrmListResponse<CustomerRow>>(
    `/api/crm/customers${qs({
      limit: params.limit,
      offset: params.offset,
      name: params.name,
      city: params.city,
      tags: params.tags?.join(','),
    })}`,
  )

/** `GET /api/crm/contacts` — paged, filterable by parent customer and name. */
export const listContacts = (
  params: { limit?: number; offset?: number; customerId?: string; name?: string } = {},
): Promise<CrmListResponse<CrmContact>> =>
  get<CrmListResponse<CrmContact>>(
    `/api/crm/contacts${qs({
      limit: params.limit,
      offset: params.offset,
      customerId: params.customerId,
      name: params.name,
    })}`,
  )

/** `GET /api/crm/followups` — paged, filterable by parent customer. */
export const listFollowups = (
  params: { limit?: number; offset?: number; customerId?: string } = {},
): Promise<CrmListResponse<CrmFollowup>> =>
  get<CrmListResponse<CrmFollowup>>(
    `/api/crm/followups${qs({
      limit: params.limit,
      offset: params.offset,
      customerId: params.customerId,
    })}`,
  )

/** `GET /api/crm/tasks` — paged, filterable by parent customer. */
export const listTasks = (
  params: { limit?: number; offset?: number; customerId?: string } = {},
): Promise<CrmListResponse<CrmTask>> =>
  get<CrmListResponse<CrmTask>>(
    `/api/crm/tasks${qs({
      limit: params.limit,
      offset: params.offset,
      customerId: params.customerId,
    })}`,
  )

/** `GET /api/crm/schedules` — paged, filterable by parent customer and date. */
export const listSchedules = (
  params: { limit?: number; offset?: number; customerId?: string; date?: string } = {},
): Promise<CrmListResponse<CrmSchedule>> =>
  get<CrmListResponse<CrmSchedule>>(
    `/api/crm/schedules${qs({
      limit: params.limit,
      offset: params.offset,
      customerId: params.customerId,
      date: params.date,
    })}`,
  )

/** `GET /api/digest?date=` — the morning digest the Home today card reads. */
export const getDigest = (date: string): Promise<DigestResponse> =>
  get<DigestResponse>(`/api/digest${qs({ date })}`)

/** `GET /api/approvals/pending` — the queue the Home awaiting decision card reads. */
export const listPendingApprovals = (): Promise<QueueResponse> =>
  get<QueueResponse>('/api/approvals/pending')
