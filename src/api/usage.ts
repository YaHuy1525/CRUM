import { Hono } from 'hono'
import { createCrumMastra } from '../mastra/index'
import { parseEnv } from '../config/env'

interface MetricsQuery {
  from: Date
  to: Date
  tenantSlug: string
}

interface UsageMetrics {
  tokensIn: number
  tokensOut: number
  cost: number
  cacheReadTokens: number
  cacheWriteTokens: number
  toolCallCount: number
  toolCallErrors: number
}

interface MetricsCapableStore {
  queryMetrics?(query: MetricsQuery): Promise<UsageMetrics>
}

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
      const storage = mastra.getStorage() as MetricsCapableStore | undefined
      const metrics = await storage?.queryMetrics?.({
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
