// src/api/signals.ts
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

/**
 * Out-of-band signals into a live conversation. §10.2.
 *
 * POST /api/signals/interrupt — abort the current run
 * POST /api/signals/correct   — steer it with a correction
 * POST /api/signals/rebind    — change the object the conversation is about
 *
 * The session id is the conversation handle the chat lane already uses
 * (`x-thread-id`), and the resource it belongs to is derived from the verified
 * identity — never from a header the client picks. `x-tenant-id` alone used to be
 * the whole authorisation model here: any client that named a tenant got a
 * session handle for it.
 *
 * What these routes can honestly promise is narrower than they look. `abort()`
 * swallows "there is no live subscription" (its own declaration: "Abort the live
 * subscription's in-flight run, if any. Swallows errors."), so a 200 here means
 * the session was asked to stop, not that a run was cancelled. The console reads
 * the actual outcome from the stream it is already holding, which is the only
 * place a live run can be observed. `/rebind` is the one route that does get a
 * confirmation: `sendSignal` returns an `accepted` promise, and it is awaited.
 *
 * Each route verifies the caller before it verifies the body, and verifies the
 * body before it recovers a session — an unauthenticated request is refused
 * before any of the rest is looked at, while a typo in a request body does not
 * cost a storage round-trip.
 */

export interface SignalsRouterDeps {
  env: CrumEnv
  /**
   * The built instance. Null before the Mastra registry exists, which the routes
   * answer as 503 rather than pretending a session was reached.
   */
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

  /**
   * A refusal the route can answer with immediately. Named, because both phases
   * below return it and the union it sits in is what the routes destructure.
   */
  interface Refused {
    error: Response
  }

  /** A verified caller and the conversation handle they named. */
  interface Caller {
    identity: TenantRequestContext
    sessionId: string
    mastra: Mastra
  }

  /** A caller's handle on their own live-or-recovered session. */
  interface Opened {
    session: Session<unknown>
    requestContext: RequestContext
    sessionId: string
  }

  /**
   * Who is asking, and which conversation they named. Deliberately the first of
   * two phases: a request with a malformed body should never reach the session
   * layer at all, and recovering a session is not free.
   */
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

  /**
   * The caller's handle on that conversation, plus the context a steered run
   * needs. Identity still short-circuits first (it is the fail-closed check);
   * this is the part a body validation can sit in front of.
   */
  const open = async (c: Context, who: Caller): Promise<Refused | Opened> => {
    const resolved = await resolveSession(who.mastra, {
      sessionId: who.sessionId,
      tenantId: who.identity.tenantId,
      resourceId: resourceIdFor(who.identity),
    })
    if (!resolved.ok) {
      // 'wrong-resource' and 'not-started' answer identically on purpose, with
      // wording that names neither the tenant nor the resource: telling them
      // apart would confirm which session ids exist in someone else's account.
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

    // A steered or signalled run executes tools, and every tool validates the
    // flat identity convention out of the request context. Handing it a bare
    // context would fail closed inside the tool after the model was already
    // billed for the turn.
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

    // A `state` signal is the framework's cross-turn channel: it is retained, so
    // the binding survives into the next turn rather than being read once and
    // dropped. The shape is the one the agent's instructions describe.
    //
    // `sendSignal` answers synchronously with `{ id, type, accepted }`, where
    // `accepted` is the dispatch promise. Dropping it would make a rejected
    // dispatch an unhandled rejection and let the route claim an ok it did not
    // earn, so it is awaited here and a failure is reported as one.
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
