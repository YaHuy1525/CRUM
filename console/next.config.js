/**
 * CRUM console configuration. §10.2, §13.6.
 *
 * The browser only ever talks to this origin (:3000). Two rewrites forward the
 * two server planes, so there is no CORS surface and no `NEXT_PUBLIC_` value
 * holding a port, an origin, or anything resembling a credential.
 *
 *   /chat/*  -> the Mastra server (CRUM_API_PORT, default 4111): the v7 UI chat
 *              route registered in `src/mastra/index.ts`.
 *   /api/*   -> the hand-rolled Hono REST plane (CRUM_REST_PORT, default 4113):
 *              approvals, knowledge, signals, agent threads, crm reads.
 *
 * `MASTRA_BASE_URL`/`MASTRA_API_PREFIX` are gone rather than wired: this app has
 * no use for a browser-side base URL when every request is same-origin, and a
 * variable nobody reads is how a console ends up pointing at a port nobody
 * started. Identity is not handled here — see `middleware.ts`.
 *
 * @type {import('next').NextConfig}
 */
const MASTRA_ORIGIN = process.env.CRUM_MASTRA_ORIGIN ?? 'http://localhost:4111'
const REST_ORIGIN = process.env.CRUM_REST_ORIGIN ?? 'http://localhost:4113'

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: '/chat/:path*', destination: `${MASTRA_ORIGIN}/chat/:path*` },
      { source: '/api/:path*', destination: `${REST_ORIGIN}/api/:path*` },
    ]
  },
}

module.exports = nextConfig
