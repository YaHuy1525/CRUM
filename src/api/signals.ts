import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { Mastra } from '@mastra/core/mastra'
import type { Session } from '@mastra/core/agent-controller'
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from '@mastra/core/request-context'
import type { CrumEnv } from '../config/env'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import type { TenantRequestContext } from '../mastra/tenant-context'
import { resourceIdFor, resolveSession } from '../mastra/sessions'


export interface SignalsRouterDeps {
  env: CrumEnv
  getMastra?: () => Mastra | null
}

const SessionQuery = z.object({
  objectType: z.enum(['customer', 'contact', 'task', 'followup', 'schedule']),
  objectId: z.string().min(1),
})

const Correction = z.object({
  content: z.string().min(1).max(8_000),
})

export function createSignalsRouter(deps: SignalsRouterDeps): Hono {
  const { env } = deps
  const app = new Hono().basePath('/api/signals')

  interface Refused {
    error: Response
  }

  interface Caller {
    identity: TenantRequestContext
    sessionId: string
    mastra: Mastra
  }

  interface Opened {
    session: Session<unknown>
    requestContext: RequestContext
    sessionId: string
  }

  const caller = async (c: Context): Promise<Refused | Caller> => {
    let identity
    try {
      identity = await resolveIdentity((name) => c.req.header(name), env)
    } catch (err) {
      if (err instanceof IdentityError) {
        return { error: c.json({ error: 'unauthorized', reason: err.reason }, 401) }
      }
      throw err
    }

    const sessionId = c.req.header('x-session-id')
    if (!sessionId) {
      return { error: c.json({ error: 'x-session-id header required' }, 400) }
    }

    const mastra = deps.getMastra?.() ?? null
    if (!mastra) {
      return {
        error: c.json(
          { error: 'agent-not-wired', detail: 'This router was created without getMastra, so no session can be reached.' },
          503,
        ),
      }
    }

    return { identity, sessionId, mastra }
  }

  const open = async (c: Context, who: Caller): Promise<Refused | Opened> => {
    const resolved = await resolveSession(who.mastra, {
      sessionId: who.sessionId,
      tenantId: who.identity.tenantId,
      resourceId: resourceIdFor(who.identity),
    })
    if (!resolved.ok) {
      return {
        error: c.json(
          {
            error: 'session_not_found',
            detail: resolved.reason === 'controller-missing'
              ? 'No AgentController is registered on this instance.'
              : 'No conversation with that id belongs to you.',
          },
          404,
        ),
      }
    }

    const requestContext = new RequestContext()
    requestContext.set('tenantId', who.identity.tenantId)
    requestContext.set('userId', who.identity.userId)
    requestContext.set('userRole', who.identity.userRole)
    requestContext.set(MASTRA_RESOURCE_ID_KEY, resourceIdFor(who.identity))
    requestContext.set(MASTRA_THREAD_ID_KEY, who.sessionId)

    return { session: resolved.session, requestContext, sessionId: who.sessionId }
  }

  app.post('/interrupt', async (c) => {
    const who = await caller(c)
    if ('error' in who) return who.error

    const t = await open(c, who)
    if ('error' in t) return t.error

    t.session.abort()
    return c.json({ ok: true, session_id: t.sessionId, signal: 'interrupt' })
  })

  app.post('/correct', async (c) => {
    const who = await caller(c)
    if ('error' in who) return who.error

    const body = Correction.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'content is required', detail: body.error.issues.map((i) => i.message) }, 400)
    }

    const t = await open(c, who)
    if ('error' in t) return t.error

    await t.session.steer({ content: body.data.content, requestContext: t.requestContext })
    return c.json({ ok: true, session_id: t.sessionId, signal: 'correct' })
  })

  app.post('/rebind', async (c) => {
    const who = await caller(c)
    if ('error' in who) return who.error

    const body = SessionQuery.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'a known objectType and objectId are required', detail: body.error.issues.map((i) => i.message) }, 400)
    }

    const t = await open(c, who)
    if ('error' in t) return t.error

    const sent = t.session.sendSignal({
      type: 'state',
      contents: JSON.stringify({ objectBinding: { type: body.data.objectType, id: body.data.objectId } }),
    })
    try {
      await sent.accepted
    } catch (err) {
      return c.json(
        { error: 'rebind_not_accepted', detail: err instanceof Error ? err.message : String(err) },
        502,
      )
    }

    return c.json({
      ok: true,
      session_id: t.sessionId,
      signal: 'rebind',
      signal_id: sent.id,
      object_binding: body.data,
    })
  })

  return app
}
