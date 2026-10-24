// src/api/signals.ts
import { Hono } from 'hono'
import { resolveSession } from '../mastra/sessions'

export function createSignalsRouter(): Hono {
  const app = new Hono().basePath('/api/signals')

  app.use('*', async (c, next) => {
    const tenantId = c.req.header('x-tenant-id')
    if (!tenantId) return c.json({ error: 'x-tenant-id header required' }, 400)
    c.set('tenantId', tenantId)
    await next()
  })

  app.post('/interrupt', async (c) => {
    const sessionId = c.req.header('x-session-id')
    if (!sessionId) return c.json({ error: 'x-session-id header required' }, 400)
    const { session } = await resolveSession({ sessionId, tenantId: c.get('tenantId') })
    session.abort()
    return c.json({ ok: true })
  })

  app.post('/correct', async (c) => {
    const sessionId = c.req.header('x-session-id')
    if (!sessionId) return c.json({ error: 'x-session-id header required' }, 400)
    const body = await c.req.json()
    if (!body.content || typeof body.content !== 'string') {
      return c.json({ error: 'content is required' }, 400)
    }
    const { session } = await resolveSession({ sessionId, tenantId: c.get('tenantId') })
    await session.steer({ content: body.content })
    return c.json({ ok: true })
  })

  app.post('/rebind', async (c) => {
    const sessionId = c.req.header('x-session-id')
    if (!sessionId) return c.json({ error: 'x-session-id header required' }, 400)
    const body = await c.req.json()
    if (!body.objectType || !body.objectId) {
      return c.json({ error: 'objectType and objectId are required' }, 400)
    }
    const { session } = await resolveSession({ sessionId, tenantId: c.get('tenantId') })
    await session.sendSignal({
      type: 'state',
      contents: JSON.stringify({ objectBinding: { type: body.objectType, id: body.objectId } }),
    })
    return c.json({ ok: true })
  })

  return app
}
