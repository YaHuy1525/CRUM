import { describe, it, expect, vi } from 'vitest'
import { RequestContext, MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY } from '@mastra/core/request-context'
import type { Middleware, ServerConfig } from '@mastra/core/server'
import { buildCrumServerConfig } from '../../src/mastra/index'
import { parseEnv } from '../../src/config/env'

const TENANT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const USER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

/** The slice of the Hono context the identity handler actually touches. */
interface StubContext {
  req: { header: (name: string) => string | undefined }
  get: (key: string) => unknown
  set: (key: string, value: unknown) => void
  json: (body: unknown, status: number) => { body: unknown; status: number }
}

type Handler = (c: StubContext, next: () => Promise<void>) => Promise<unknown>

function extractHandler(config: ServerConfig): Handler {
  const first = (config.middleware as Middleware[])[0] as { handler: unknown }
  return first.handler as unknown as Handler
}

function makeContext(headers: Record<string, string>, withRequestContext = true) {
  const rc = new RequestContext()
  const store: Record<string, unknown> = withRequestContext ? { requestContext: rc } : {}
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  const c: StubContext = {
    req: { header: (name) => lower[name.toLowerCase()] },
    get: (key) => store[key],
    set: (key, value) => {
      store[key] = value
    },
    json: (body, status) => ({ body, status }),
  }
  return { c, rc }
}

const devConfig = buildCrumServerConfig(parseEnv({ NODE_ENV: 'test' }))

describe('CRUM server middleware', () => {
  it('writes BOTH the nested and flat tenant conventions plus the resource id', async () => {
    const handler = extractHandler(devConfig)
    const { c, rc } = makeContext({
      'x-tenant-id': TENANT,
      'x-user-id': USER,
      'x-user-role': 'user',
    })
    const next = vi.fn().mockResolvedValue(undefined)

    await handler(c, next)

    expect(next).toHaveBeenCalledTimes(1)
    // NESTED convention consumed by agent.ts defaultOptions.
    expect(rc.get('tenantContext')).toEqual({ tenantId: TENANT, userId: USER, userRole: 'user' })
    // FLAT convention consumed by each tool's requestContextSchema.
    expect(rc.get('tenantId')).toBe(TENANT)
    expect(rc.get('userId')).toBe(USER)
    expect(rc.get('userRole')).toBe('user')
    // Tenant-qualified resource id for memory/thread scoping (§4.2).
    expect(rc.get(MASTRA_RESOURCE_ID_KEY)).toBe(`${TENANT}:${USER}`)
  })

  it('threads the x-thread-id header through the reserved key', async () => {
    const handler = extractHandler(devConfig)
    const { c, rc } = makeContext({
      'x-tenant-id': TENANT,
      'x-user-id': USER,
      'x-user-role': 'admin',
      'x-thread-id': 'thread-42',
    })
    await handler(c, vi.fn().mockResolvedValue(undefined))
    expect(rc.get(MASTRA_THREAD_ID_KEY)).toBe('thread-42')
  })

  it('mints a thread id when no thread header is present', async () => {
    const handler = extractHandler(devConfig)
    const { c, rc } = makeContext({
      'x-tenant-id': TENANT,
      'x-user-id': USER,
      'x-user-role': 'user',
    })
    await handler(c, vi.fn().mockResolvedValue(undefined))
    // Core memory requires an active thread; leaving it unset made the
    // goal-state processor throw before the first model call.
    expect(rc.get(MASTRA_THREAD_ID_KEY)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  it('short-circuits with 401 and never calls next() on a missing claim', async () => {
    const handler = extractHandler(devConfig)
    const { c } = makeContext({ 'x-user-id': USER, 'x-user-role': 'user' })
    const next = vi.fn().mockResolvedValue(undefined)

    const result = (await handler(c, next)) as { status: number }

    expect(next).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 401 })
  })

  it('short-circuits with 401 on a malformed UUID', async () => {
    const handler = extractHandler(devConfig)
    const { c } = makeContext({
      'x-tenant-id': 'nope',
      'x-user-id': USER,
      'x-user-role': 'user',
    })
    const next = vi.fn().mockResolvedValue(undefined)

    const result = (await handler(c, next)) as { status: number }

    expect(next).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 401 })
  })

  it('installs a fresh RequestContext when the framework did not pre-create one', async () => {
    const handler = extractHandler(devConfig)
    const { c } = makeContext(
      { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'user' },
      false,
    )
    await handler(c, vi.fn().mockResolvedValue(undefined))
    const installed = c.get('requestContext') as RequestContext
    expect(installed).toBeInstanceOf(RequestContext)
    expect(installed.get('tenantId')).toBe(TENANT)
  })

  it('serves the chat route outside the /api prefix', () => {
    const paths = (devConfig.apiRoutes ?? []).map((r) => (r as { path?: string }).path)
    expect(paths).toContain('/chat/crm')
    // The chat route must be a top-level route, not proxied under /api.
    // The Gmail OAuth routes intentionally live under /api, so check chat only.
    expect(paths).not.toContain('/api/chat/crm')
  })
})
