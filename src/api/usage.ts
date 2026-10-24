// src/api/usage.ts
import { Hono } from 'hono'
import { createCrumMastra } from '../mastra/index'
import { parseEnv } from '../config/env'

/**
 * §7.7 — Usage dashboard: tokens in/out per tenant per day, cost per model,
 * cache read/write tokens, ceiling headroom, tool call success rate.
 * Reads from the observability metrics domain (PostgresStoreVNext).
 */
export function createUsageRouter(): Hono {
  const app = new Hono().basePath('/api/usage')

  app.get('/', async (c) => {
    const tenantId = c.req.header('x-tenant-id')
    if (!tenantId) {
      return c.json({ error: 'x-tenant-id header required' }, 400)
    }

    const from = c.req.query('from')
    const to = c.req.query('to')

    const env = parseEnv()
    const mastra = createCrumMastra(env)

    try {
      // Query the observability metrics domain
      // PostgresStoreVNext serves metric queries; InMemoryStore cannot
      const metrics = await mastra.storage.queryMetrics?.({
        from: from ? new Date(from) : new Date(Date.now() - 7 * 86400000),
        to: to ? new Date(to) : new Date(),
        tenantSlug: tenantId,
      })

      if (!metrics) {
        return c.json({ error: 'Metrics not available — is PostgresStoreVNext configured?' }, 503)
      }

      return c.json(metrics)
    } catch (err) {
      console.error('queryMetrics failed:', err)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  return app
}
