// src/api/index.ts
import { Hono } from 'hono'
import { createFeedbackRouter } from './feedback'
import { createUsageRouter } from './usage'
import { createDigestRouter } from './digest'

/**
 * Aggregate API router. Mounts all sub-routers under their respective
 * base paths. Individual routers use `.basePath()` internally, so this
 * file mounts them all at `/`.
 */
export function createApiRouter(): Hono {
  const app = new Hono()

  app.route('/', createFeedbackRouter())
  app.route('/', createUsageRouter())
  app.route('/', createDigestRouter())

  return app
}
