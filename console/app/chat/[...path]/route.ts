import { NextRequest, NextResponse } from 'next/server'

import { resolveIdentity } from '@/lib/identity'

/**
 * The chat lane: a same-origin proxy onto the Mastra server's `/chat/*` routes.
 *
 * This exists instead of a `next.config.js` rewrite because the rewrite proxy
 * buffers the response. The chat turn is a `text/event-stream` that can run for
 * a minute, and a buffered stream means the browser renders nothing until the
 * agent has already finished, which reads as a broken chat. Returning the
 * upstream body here passes the stream through chunk by chunk: measured on
 * 2026-10-27, first byte at 7.3s of a 72.7s turn, where the rewrite delivered
 * everything in one block at the end of the turn.
 *
 * Identity is the console's own policy, shared with `middleware.ts` through
 * `lib/identity.ts`, so a browser cannot name the tenant it talks about and the
 * console still needs no `NEXT_PUBLIC_` port or origin.
 */
const MASTRA_ORIGIN = process.env.CRUM_MASTRA_ORIGIN ?? 'http://localhost:4111'

// Headers that describe the hop rather than the request. `host` has to go so the
// plane sees its own address, and `accept-encoding` has to go because the body is
// relayed verbatim: a compressed stream would be forwarded under a
// `content-type` the client cannot decode, and `content-length` would be wrong.
const HOP_BY_HOP = [
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
]

// Response headers that cannot be relayed: the body is streamed again from this
// process, so a `content-length` from the plane would be a lie, a
// `content-encoding` would name a compression the client never asked for (this
// fetch asks for none), and the connection headers belong to the plane socket.
const STRIP_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
])

async function forward(request: NextRequest, params: { path?: string[] }): Promise<NextResponse> {
  const identity = resolveIdentity(request)
  if (identity.refusal) {
    const { status, error, detail } = identity.refusal
    return NextResponse.json({ error, detail }, { status })
  }

  for (const header of HOP_BY_HOP) identity.headers.delete(header)

  const segments = (params.path ?? []).map(encodeURIComponent).join('/')
  const url = `${MASTRA_ORIGIN}/chat/${segments}${request.nextUrl.search}`
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'

  let upstream: Response
  try {
    upstream = await fetch(url, {
      method: request.method,
      headers: identity.headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      cache: 'no-store',
      signal: request.signal,
    })
  } catch (cause) {
    // The plane is down or the socket broke mid-turn. The console shows this as a
    // chat error rather than a hung composer, so say which origin was reached for.
    return NextResponse.json(
      {
        error: 'chat-plane-unreachable',
        detail: `Could not reach the chat plane at ${MASTRA_ORIGIN}: ` +
          `${cause instanceof Error ? cause.message : String(cause)}. ` +
          'Start it with `npm run dev` in the repo root, or point CRUM_MASTRA_ORIGIN somewhere live.',
      },
      { status: 502 },
    )
  }

  const headers = new Headers()
  // Relay whatever the plane declared (its own `x-thread-id`, the AI UI message
  // stream hints) and drop only the headers that describe the hop we just
  // finished or would lie about a body we have not measured.
  for (const [name, value] of upstream.headers.entries()) {
    if (STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) continue
    headers.set(name, value)
  }
  headers.set('content-type', upstream.headers.get('content-type') ?? 'application/json')
  headers.set('cache-control', upstream.headers.get('cache-control') ?? 'no-cache, no-transform')
  headers.set('x-accel-buffering', 'no')

  // `upstream.body` is the live stream: handing it to Response keeps the SSE frames
  // arriving as the agent produces them.
  return new NextResponse(upstream.body, { status: upstream.status, headers })
}

type RouteContext = { params: Promise<{ path?: string[] }> }

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return forward(request, await context.params)
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  return forward(request, await context.params)
}
