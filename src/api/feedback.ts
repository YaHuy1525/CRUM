// src/api/feedback.ts
import { Hono } from 'hono'
import { z } from 'zod'
import type { FeedbackInput } from '@mastra/core/observability'
import { createCrumMastra } from '../mastra/index'
import { parseEnv } from '../config/env'

const FeedbackSchema = z.object({
  traceId: z.string().min(1),
  spanId: z.string().optional(),
  vote: z.enum(['up', 'down']),
  comment: z.string().optional(),
  tenantSlug: z.string().optional(),
  customerId: z.string().optional(),
  agentId: z.string().optional(),
})

/**
 * §11.4 — Feedback control: thumbs up/down on each assistant turn.
 * Writes to observability.addFeedback(), no bespoke table (§8.5).
 */
export function createFeedbackRouter(): Hono {
  const app = new Hono().basePath('/api/feedback')

  app.post('/', async (c) => {
    const tenantId = c.req.header('x-tenant-id')
    if (!tenantId) {
      return c.json({ error: 'x-tenant-id header required' }, 400)
    }

    // `unknown`, not `any`: the schema below is what decides the shape, and the
    // route must not be able to read a field the schema did not check.
    const body = await c.req.json<unknown>()
    const parsed = FeedbackSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'Invalid feedback', issues: parsed.error.issues }, 400)
    }

    const { traceId, spanId, vote, comment, tenantSlug, customerId, agentId } = parsed.data

    const env = parseEnv()
    const mastra = createCrumMastra(env)

    const feedback: FeedbackInput = {
      feedbackType: 'thumbs',
      value: vote,
      feedbackSource: 'user',
    }
    if (comment !== undefined) {
      feedback.comment = comment
    }

    const metadata: Record<string, string> = {}
    if (tenantSlug !== undefined) metadata.tenantSlug = tenantSlug
    if (customerId !== undefined) metadata.customerId = customerId
    if (agentId !== undefined) metadata.agentId = agentId
    if (Object.keys(metadata).length > 0) {
      feedback.metadata = metadata
    }

    try {
      await mastra.observability.addFeedback?.({
        traceId,
        spanId,
        feedback,
      })
    } catch (err) {
      console.error('addFeedback failed:', err)
      return c.json({ error: 'Internal server error' }, 500)
    }

    return c.json({ ok: true })
  })

  return app
}
