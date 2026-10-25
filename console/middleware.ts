// console/middleware.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Identity injection for the two proxied planes. §13.2, §13.6.
 *
 * Both the chat route (`/chat/crm` on :4111) and every REST route (`/api/*` on
 * :4113) resolve their caller through `resolveIdentity`, which has no defaults: a
 * request without a trustworthy identity is answered 401 and never reaches an
 * agent or a row. Somebody therefore has to attach that identity, and the two
 * candidates were the browser or this middleware.
 *
 * It is this middleware. Putting the claims in the bundle would mean
 * `NEXT_PUBLIC_*` variables — public by construction, shipped to every visitor,
 * and the exact shape §13.6 rules out — and it would also mean the browser gets
 * to choose which tenant a request speaks for. So the claims come from this
 * server's own environment and are *set*, not merged: a client-supplied
 * `x-tenant-id` is dropped here before it can reach a route that would believe
 * it.
 *
 * Two modes, mirroring `CRUM_AUTH_MODE` on the server:
 *
 * - `dev` (default): injects `x-tenant-id` / `x-user-id` / `x-user-role` from
 *   `CRUM_DEV_*`. Unset or malformed is refused with 503 rather than forwarded
 *   anonymously, because "the console is misconfigured" and "you are not
 *   authorised" are different facts and the operator needs to hear the first one.
 * - `jwt`: injects nothing. The browser's own `Authorization: Bearer` (a Supabase
 *   access token, which is a credential for that user and not a secret of this
 *   app's) is forwarded untouched, and a request without one is refused locally
 *   instead of costing a round trip and a 401.
 */

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

/**
 * A local refusal, shaped like the planes' own error bodies so the console has
 * one error path to render rather than two.
 */
function refuse(status: number, error: string, detail: string): NextResponse {
  return NextResponse.json({ error, detail }, { status })
}

export function middleware(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers)
  // The `NEXT_PUBLIC_*` fallbacks exist for the containerized build. This module
  // runs in the Next.js Edge runtime, and a self-hosted `next start` only exposes
  // build-inlined `NEXT_PUBLIC_*` to that sandbox — the plain server keys are
  // present there but empty, so `||` (not `??`) is what lets a baked value win.
  // On a host (or under `next dev`) the plain names resolve first and the fallback
  // is never used. The dev identity is a non-secret local fixture, so baking it is
  // safe; `jwt` mode reads the caller's own token and ignores it.
  const authMode = process.env.CRUM_AUTH_MODE || process.env.NEXT_PUBLIC_CRUM_AUTH_MODE
  const mode = authMode === 'jwt' ? 'jwt' : 'dev'

  if (mode === 'jwt') {
    // The token is the caller's, not this app's secret: pass it through and let
    // the server verify it. Nothing here is added, so nothing here can be forged.
    if (!headers.get('authorization')) {
      return refuse(401, 'unauthorized', 'jwt mode requires a signed-in Supabase session.')
    }
    headers.delete('x-tenant-id')
    headers.delete('x-user-id')
    headers.delete('x-user-role')
    return NextResponse.next({ request: { headers } })
  }

  const tenantId = process.env.CRUM_DEV_TENANT_ID || process.env.NEXT_PUBLIC_CRUM_DEV_TENANT_ID || ''
  const userId = process.env.CRUM_DEV_USER_ID || process.env.NEXT_PUBLIC_CRUM_DEV_USER_ID || ''
  const role = process.env.CRUM_DEV_USER_ROLE || process.env.NEXT_PUBLIC_CRUM_DEV_USER_ROLE || ''

  // Same vocabulary the identity layer uses, checked here so a typo in the
  // console's environment is reported by the console rather than arriving as an
  // opaque 401 reason from a different process.
  const malformed = [
    ...(!UUID.test(tenantId) ? ['CRUM_DEV_TENANT_ID'] : []),
    ...(!UUID.test(userId) ? ['CRUM_DEV_USER_ID'] : []),
    ...(role !== 'user' && role !== 'admin' ? ['CRUM_DEV_USER_ROLE (must be "user" or "admin")'] : []),
  ]
  if (malformed.length > 0) {
    return refuse(
      503,
      'identity-not-configured',
      `The console has no dev identity to attach: ${malformed.join(', ')} set in console/.env.local. ` +
        'Nothing was forwarded to the planes, because a request without an identity is refused there anyway.',
    )
  }

  // Set (never default): whatever the browser claimed is discarded first.
  headers.set('x-tenant-id', tenantId)
  headers.set('x-user-id', userId)
  headers.set('x-user-role', role)

  return NextResponse.next({ request: { headers } })
}

/**
 * Only the proxied paths. A matcher that covered `/` would run this on every
 * document request, including the RSC payload for a page nobody is fetching data
 * from, and would refuse to render the console shell itself.
 */
export const config = {
  matcher: ['/chat/:path*', '/api/:path*'],
}
