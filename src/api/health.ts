import { Hono } from 'hono'
import { createCrumMastra } from '../mastra/index'
import { parseEnv } from '../config/env'

interface DependencyStatus {
  status: 'ok' | 'degraded'
  message?: string
}

export function createHealthRouter(): Hono {
  const app = new Hono().basePath('/health')

  app.get('/', async (c) => {
    const dependencies: Record<string, DependencyStatus> = {}

    try {
      const env = parseEnv()
      const mastra = createCrumMastra(env)
      const storage = mastra.getStorage()

      if (!storage) {
        dependencies.storage = { status: 'degraded', message: 'no storage configured' }
      } else {
        const getStatus = (storage as unknown as Record<string, ((...args: unknown[]) => Promise<unknown>) | undefined>).getStatus
        if (typeof getStatus === 'function') {
          await getStatus.call(storage)
          dependencies.storage = { status: 'ok' }
        } else {
          dependencies.storage = { status: 'ok' }
        }
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
