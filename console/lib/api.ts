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
    throw new ApiError(
      0,
      'network_unreachable',
      `Could not reach ${path.split('/').slice(0, 3).join('/')}. Is the server on :4113 (REST) / :4111 (chat) running? (${
        err instanceof Error ? err.message : String(err)
      })`,
    )
  }

  // 204 has no body; everything else is read as text and then parsed, so a plane
  // that crashes into an HTML error page becomes a readable message instead of a
  // `JSON.parse` throw inside a `.then`.
  if (response.status === 204) return undefined as T

  const text = await response.text()
  let parsed: unknown = null
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { detail: text.slice(0, 300) }
    }
  }

  if (!response.ok) throw errorFromBody(response.status, parsed)
  return parsed as T
}

export const get = <T>(path: string): Promise<T> => request<T>(path, { method: 'GET' })
export const post = <T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> =>
  request<T>(path, {
    method: 'POST',
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
