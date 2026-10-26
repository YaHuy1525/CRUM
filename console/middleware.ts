import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'


const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i

function refuse(status: number, error: string, detail: string): NextResponse {
  return NextResponse.json({ error, detail }, { status })
}

export function middleware(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers)
  const authMode = process.env.CRUM_AUTH_MODE || process.env.NEXT_PUBLIC_CRUM_AUTH_MODE
  const mode = authMode === 'jwt' ? 'jwt' : 'dev'

  if (mode === 'jwt') {
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

  headers.set('x-tenant-id', tenantId)
  headers.set('x-user-id', userId)
  headers.set('x-user-role', role)

  return NextResponse.next({ request: { headers } })
}

export const config = {
  matcher: ['/chat/:path*', '/api/:path*'],
}
