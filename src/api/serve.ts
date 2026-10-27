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


export const MAX_BODY_BYTES = 8 * 1024 * 1024

export interface ApiServerOptions {
  env: CrumEnv
  mastra: Mastra | null
  port?: number
  hostname?: string
  maxBodyBytes?: number
}

export interface ApiServerHandle {
  port: number
  server: ServerType
  close(): Promise<void>
}

export function createApiApp(deps: {
  env: CrumEnv
  getMastra: () => Mastra | null
  maxBodyBytes?: number
}): Hono {
  const { env, maxBodyBytes = MAX_BODY_BYTES } = deps
  const app = new Hono()

  app.use('*', async (c, next) => {
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
    console.error(`[CRUM] REST plane error on ${c.req.method} ${c.req.path}: ${message}`)
    return c.json({ error: 'internal_error', detail: message }, 500)
  })

  return app
}

export function startApiServer(options: ApiServerOptions): Promise<ApiServerHandle> {
  const { env } = options
  const port = options.port ?? env.CRUM_REST_PORT
  const hostname = options.hostname ?? env.CRUM_REST_HOST ?? '127.0.0.1'
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
    if ('closeAllConnections' in server) server.closeAllConnections()
    server.close(() => resolve())
  })
}

async function main(): Promise<void> {
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

function isStandaloneEntry(): boolean {
  if (isMastraServerProcess()) return false
  const entry = process.argv[1]
  if (!entry) return false
  const here = fileURLToPath(import.meta.url)
  if (basename(here) !== basename(entry)) return false
  try {
    return realpathSync(here) === realpathSync(entry)
  } catch {
    return false
  }
}

if (isStandaloneEntry()) {
  main().catch((err: unknown) => {
    console.error(`[CRUM] REST plane exited: ${String(err)}`)
    process.exitCode = 1
  })
}
