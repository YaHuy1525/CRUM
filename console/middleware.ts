import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { resolveIdentity } from '@/lib/identity'

export function middleware(request: NextRequest): NextResponse {
  const identity = resolveIdentity(request)
  if (identity.refusal) {
    const { status, error, detail } = identity.refusal
    return NextResponse.json({ error, detail }, { status })
  }
  return NextResponse.next({ request: { headers: identity.headers } })
}

export const config = {
  matcher: ['/api/:path*'],
}
