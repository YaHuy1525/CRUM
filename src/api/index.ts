// src/api/index.ts
import { Hono } from 'hono'
import { createFeedbackRouter } from './feedback'

/**
 * Aggregate API router. Mounts all sub-routers under their respective
 * base paths. Individual routers use `.basePath()` internally, so this
 * file mounts them all at `/`.
 */
export function createApiRouter(): Hono {
  const app = new Hono()

  app.route('/', createFeedbackRouter())

  return app
}
