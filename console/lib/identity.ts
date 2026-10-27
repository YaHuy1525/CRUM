/**
 * The identity both server planes expect, computed once for every same-origin
 * request the console forwards.
 *
 * Two callers read it: `middleware.ts` (which stamps the headers onto /api
 * requests before the REST rewrite) and `app/chat/[...path]/route.ts` (which
 * stamps them onto the forwarded chat turn). The chat lane cannot be a Next
 * rewrite because the rewrite proxy buffers the whole response body, and a
 * buffered SSE stream is precisely "nothing appears in the chat while the agent
 * responds": measured on 2026-10-27, a turn through the rewrite delivered its
 * first byte at 109.2s of a 109.2s turn, while the same turn posted straight to
 * the plane delivered its first byte at 7.3s of 72.7s.
 *
 * Behaviour is unchanged from the middleware that came first: `jwt` mode keeps
 * the browser's Authorization header and refuses anything without it, and strips
 * any identity a caller tried to spoof; anything else is `dev` mode, which
 * attaches the configured fixtures and refuses loudly when they are missing.
 */

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

export type IdentityRefusal = {
  status: number
  error: string
  detail: string
}

export type Identity =
  | { headers: Headers; refusal?: undefined }
  | { refusal: IdentityRefusal; headers?: undefined }

export function resolveIdentity(request: Request): Identity {
  const headers = new Headers(request.headers)
  const authMode = process.env.CRUM_AUTH_MODE || process.env.NEXT_PUBLIC_CRUM_AUTH_MODE
  const mode = authMode === 'jwt' ? 'jwt' : 'dev'

  if (mode === 'jwt') {
    if (!headers.get('authorization')) {
      return {
        refusal: {
          status: 401,
          error: 'unauthorized',
          detail: 'jwt mode requires a signed-in Supabase session.',
        },
      }
    }
    headers.delete('x-tenant-id')
    headers.delete('x-user-id')
    headers.delete('x-user-role')
    return { headers }
  }

  const tenantId = process.env.CRUM_DEV_TENANT_ID || process.env.NEXT_PUBLIC_CRUM_DEV_TENANT_ID || ''
  const userId = process.env.CRUM_DEV_USER_ID || process.env.NEXT_PUBLIC_CRUM_DEV_USER_ID || ''
  const role = process.env.CRUM_DEV_USER_ROLE || process.env.NEXT_PUBLIC_CRUM_DEV_USER_ROLE || ''

  const malformed = [
    ...(!UUID.test(tenantId) ? ['CRUM_DEV_TENANT_ID'] : []),
    ...(!UUID.test(userId) ? ['CRUM_DEV_USER_ID'] : []),
    ...(role !== 'user' && role !== 'admin' ? ['CRUM_DEV_USER_ROLE (must be "user" or "admin")'] : []),
  ]
  if (malformed.length > 0) {
    return {
      refusal: {
        status: 503,
        error: 'identity-not-configured',
        detail:
          `The console has no dev identity to attach: ${malformed.join(', ')} set in console/.env.local. ` +
          'Nothing was forwarded to the planes, because a request without an identity is refused there anyway.',
      },
    }
  }

  headers.set('x-tenant-id', tenantId)
  headers.set('x-user-id', userId)
  headers.set('x-user-role', role)

  return { headers }
}
