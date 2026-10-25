// src/api/serve.ts
import { existsSync, realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import { Hono } from 'hono'
import type { Mastra } from '@mastra/core/mastra'
import type { CrumEnv } from '../config/env'
import { parseEnv } from '../config/env'
import { createCrumMastra } from '../mastra'
import { isMastraServerProcess } from '../mastra/boot'
import { createApiRouter } from './index'

/**
 * The hand-rolled REST plane (§10.2).
 *
 * It exists because Mastra reserves `/api` for its own routes and `registerApiRoute`
 * documents `:param` only — no splat — so the nine routers in `./index.ts` cannot be
 * mounted on the Mastra server. They are served here instead, on `CRUM_REST_PORT`
 * (4113 by default), and the console reaches them through a Next rewrite so the
 * browser only ever talks to one origin.
 *
 * Why the server process starts this itself (`src/mastra/boot.ts`, called from the
 * CLI entry) rather than only via `dev:api` in another terminal: an
 * `AgentController` session is in memory in the process that owns the live run
 * (`getSession` reads a map, not a table). A REST plane in a second process could
 * still list threads and read the approval queue — both are storage-backed — but
 * `/api/signals/correct` would recover the session from its stored thread and steer
 * a copy that nobody is streaming, which looks like a successful interrupt and is
 * not one. Same process is what makes the signal routes mean what they say.
 */

/**
 * Bodies larger than this are refused before they are read. `knowledge/upload` is
 * the only route here that takes a document, and an unbounded upload on a plane
 * that awaits ingestion inside the request is a memory problem, not a storage one.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

export interface ApiServerOptions {
  env: CrumEnv
  /**
   * The built registry, or null when it could not be built. Passing null serves
   * the plane anyway: every router answers its own 503, which is a better
   * failure than a port that never opens and a log line nobody reads.
   */
  mastra: Mastra | null
  /** Overrides `env.CRUM_REST_PORT`. `0` asks the OS for an ephemeral port. */
  port?: number
  hostname?: string
  /** Test seam: replaces the per-request body ceiling. */
  maxBodyBytes?: number
}

export interface ApiServerHandle {
  /** The bound port, which is only known until after listen when `port: 0`. */
  port: number
  server: ServerType
  close(): Promise<void>
}

/**
 * The composed Hono app: every mounted router, plus the plane-level answers that
 * no router owns — a JSON 404 (an unmatched path on an API is data, not a page),
 * a JSON 500 (a route that throws must not return the framework's plain-text
 * "Internal Server Error" to a fetch client), and the body ceiling.
 */
export function createApiApp(deps: {
  env: CrumEnv
  getMastra: () => Mastra | null
  maxBodyBytes?: number
}): Hono {
  const { env, maxBodyBytes = MAX_BODY_BYTES } = deps
  const app = new Hono()

  app.use('*', async (c, next) => {
    // Only the declared length is checked: `@hono/node-server` exposes no byte
    // counter, so a chunked upload that lies about its size is bounded by the
    // route that reads it, not here. Stated rather than pretended.
    const declared = c.req.header('content-length')
    if (declared !== undefined && Number(declared) > maxBodyBytes) {
      return c.json(
        { error: 'payload_too_large', detail: `Request body exceeds ${maxBodyBytes} bytes.` },
        413,
      )
    }
    return next()
  })

  app.route('/', createApiRouter({ env, getMastra: deps.getMastra }))

  app.notFound((c) =>
    c.json({ error: 'not_found', detail: `No route on this plane matches ${c.req.path}.` }, 404),
  )

  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err)
    // Logged with the path so a 500 in the console is traceable to a route; the
    // response itself carries no stack, because this plane is reachable from a
    // browser-facing origin through the console's rewrite.
    console.error(`[CRUM] REST plane error on ${c.req.method} ${c.req.path}: ${message}`)
    return c.json({ error: 'internal_error', detail: message }, 500)
  })

  return app
}

/**
 * Binds the REST plane. Resolves once the socket is listening, and rejects if the
 * port is taken — the caller decides whether that is fatal (`src/mastra/boot.ts`
 * logs it and resolves null, because a missing REST plane must not take the chat
 * lane down with it).
 */
export function startApiServer(options: ApiServerOptions): Promise<ApiServerHandle> {
  const { env } = options
  const port = options.port ?? env.CRUM_REST_PORT
  const hostname = options.hostname ?? '127.0.0.1'
  const app = createApiApp({
    env,
    getMastra: () => options.mastra,
    maxBodyBytes: options.maxBodyBytes,
  })

  return new Promise<ApiServerHandle>((resolve, reject) => {
    let settled = false
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      settled = true
      resolve({
        port: info.port,
        server,
        close: () => closeServer(server),
      })
    })

    // An unhandled 'error' event on an http.Server throws, and a throw from an
    // event listener would crash the process that also serves the chat lane.
    server.once('error', (err: unknown) => {
      if (settled) {
        console.error(`[CRUM] REST plane failed after listening: ${String(err)}`)
        return
      }
      settled = true
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })
}

async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve) => {
    // `close()` waits for keep-alive sockets to idle, which on a test run means
    // forever; `closeAllConnections()` (Node 18.2+, and only on the http server
    // variant of the union) is what makes the handle actually releasable so a
    // suite can bind the same port twice.
    if ('closeAllConnections' in server) server.closeAllConnections()
    server.close(() => resolve())
  })
}

/**
 * Standalone entry (`npm run dev:api`). Route-iteration without the Mastra server;
 * sessions are recovered from storage, and a run living in another process is not
 * reachable from here — see the header comment for why the normal dev command does
 * not need this one.
 */
async function main(): Promise<void> {
  // `mastra dev` loads `.env` for you; a bare `tsx` process does not, and this
  // plane reads configuration at startup like the server it runs beside. Absent
  // file is not an error — every DB-backed route then answers its own failure,
  // which is a truer outcome than a route silently reading someone else's stack.
  const envPath = new URL('../../.env', import.meta.url)
  if (existsSync(envPath)) process.loadEnvFile(envPath)

  const env = parseEnv()
  const mastra = createCrumMastra(env)
  const handle = await startApiServer({ env, mastra })
  console.log(`[CRUM] REST plane listening on http://127.0.0.1:${handle.port}`)
  console.log(
    `[CRUM] The Mastra server is a separate process here (CRUM_API_PORT=${env.CRUM_API_PORT}), so /api/signals/* can only reach a session started in this one.`,
  )

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void handle.close().then(() => process.exit(0))
    })
  }
}

/**
 * True when this file is the process entry *and* we are not running from inside
 * the built Mastra server.
 *
 * Both halves are needed. The basename/realpath comparison alone is not enough:
 * the plane is reachable from a server process in two different ways — as the
 * `.mastra/output/serve.mjs` chunk that `src/mastra/boot.ts` imports, and as the
 * file a developer runs directly with `npm run dev:api`. Only the second is
 * supposed to call `main()`; the first already has a plane bound for it, and a
 * second `startApiServer` would collide on the port and build a second Mastra
 * registry. `isMastraServerProcess()` answers that by asking where *its own*
 * module was loaded from, which is true for every chunk of the bundle and false
 * for every source-mode run.
 */
function isStandaloneEntry(): boolean {
  if (isMastraServerProcess()) return false
  const entry = process.argv[1]
  if (!entry) return false
  const here = fileURLToPath(import.meta.url)
  if (basename(here) !== basename(entry)) return false
  try {
    return realpathSync(here) === realpathSync(entry)
  } catch {
    // The argv path no longer exists (a temp entry from a watcher). Not us.
    return false
  }
}

if (isStandaloneEntry()) {
  main().catch((err: unknown) => {
    console.error(`[CRUM] REST plane exited: ${String(err)}`)
    process.exitCode = 1
  })
}
