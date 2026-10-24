// src/api/digest.ts
import { Hono } from 'hono'
import { createCrumMastra } from '../mastra/index'
import { parseEnv } from '../config/env'
import { digestWorkflow } from '../mastra/workflows/digest'

/**
 * §11 — Digest API: runs the crum-digest workflow and returns the result.
 *
 * GET /api/digest?date=YYYY-MM-DD&staleDays=N
 * Requires x-tenant-id header.
 */
export function createDigestRouter(): Hono {
  const app = new Hono().basePath('/api/digest')

  app.get('/', async (c) => {
    const tenantId = c.req.header('x-tenant-id')
    if (!tenantId) {
      return c.json({ error: 'x-tenant-id header required' }, 400)
    }

    const date = c.req.query('date') || undefined
    const staleDaysParam = c.req.query('staleDays')
    const staleDays = staleDaysParam ? Number(staleDaysParam) : undefined

    if (staleDaysParam && (isNaN(staleDays!) || staleDays! < 1)) {
      return c.json({ error: 'staleDays must be a positive integer' }, 400)
    }

    const env = parseEnv()
    const mastra = createCrumMastra(env)

    try {
      const wf = mastra.getWorkflow('crum-digest') ?? digestWorkflow
      const run = await wf.createRun()
      const result = await run.start({
        inputData: {
          tenantId,
          ...(date ? { date } : {}),
          ...(staleDays ? { staleDays } : {}),
        },
      })

      if (result.status === 'success') {
        return c.json(result.result)
      }

      if (result.status === 'failed') {
        console.error('Digest workflow failed:', result.error)
        return c.json({ error: 'Digest workflow failed', detail: result.error?.message }, 500)
      }

      return c.json({ error: `Unexpected workflow status: ${result.status}` }, 500)
    } catch (err) {
      console.error('Digest API error:', err)
      return c.json({ error: 'Internal server error' }, 500)
    }
  })

  return app
}
