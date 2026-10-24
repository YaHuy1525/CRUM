// src/api/health.ts
import { Hono } from 'hono'
import { createCrumMastra } from '../mastra/index'
import { parseEnv } from '../config/env'

interface DependencyStatus {
  status: 'ok' | 'degraded'
  message?: string
}

/**
 * §8.7 — Health endpoint: per-dependency status.
 *
 * Probes storage reachability. Observability is a soft dependency — fail-open
 * semantics mean an observability outage has no user impact, so it is not
 * probed here.
 *
 * Returns `{ status: 'ok' | 'degraded', dependencies: { storage: {...} } }`.
 * Overall status is 'ok' only when every probed dependency is 'ok'.
 */
export function createHealthRouter(): Hono {
  const app = new Hono().basePath('/health')

  app.get('/', async (c) => {
    const dependencies: Record<string, DependencyStatus> = {}

    // Probe storage
    try {
      const env = parseEnv()
      const mastra = createCrumMastra(env)
      const storage = mastra.getStorage()

      if (!storage) {
        dependencies.storage = { status: 'degraded', message: 'no storage configured' }
      } else if (typeof (storage as Record<string, unknown>).getStatus === 'function') {
        await (storage as Record<string, (...args: unknown[]) => Promise<unknown>>).getStatus()
        dependencies.storage = { status: 'ok' }
      } else {
        // Storage exists but has no getStatus method — assume reachable
        dependencies.storage = { status: 'ok' }
      }
    } catch (err) {
      dependencies.storage = {
        status: 'degraded',
        message: err instanceof Error ? err.message : 'unknown error',
      }
    }

    const overallStatus = Object.values(dependencies).every((d) => d.status === 'ok')
      ? 'ok'
      : 'degraded'

    return c.json({ status: overallStatus, dependencies })
  })

  return app
}
