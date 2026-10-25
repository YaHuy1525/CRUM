// src/api/agent.ts
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Mastra } from '@mastra/core/mastra'
import type { CrumEnv } from '../config/env'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import { CRUM_AGENT_CONTROLLER_ID, queryThreads, resourceIdFor } from '../mastra/sessions'

/**
 * Conversation reads for the console's session sidebar. §4.2, §10.2.
 *
 * GET /api/agent/threads — the caller's own conversations, newest first.
 *
 * This replaces the mock array in `SessionList.tsx`. Threads are read straight
 * from storage through the AgentController (`queryThreads` → `listThreads`), so
 * the list survives a restart and never provisions a session — the §16 Phase 1
 * acceptance was "the session list renders under 300ms without provisioning a
 * workspace", and this path holds no workspace, no model and no run.
 *
 * Two things this deliberately does not offer, because the schema cannot:
 * there is no tenant-wide thread listing (storage filters by an exact
 * `resourceId`, and CRUM's resource is `tenantId:userId`, so an admin cannot
 * enumerate a tenant's conversations without knowing each user id), and message
 * history is not projected here — `useChat` owns the transcript, and inventing a
 * second message shape for the sidebar would be a second source of truth.
 */

export interface AgentRouterDeps {
  env: CrumEnv
  /** Null before the Mastra registry exists, answered as a real 503. */
  getMastra?: () => Mastra | null
  /** Controller registry key. Defaults to the CRUM assistant controller. */
  agentId?: string
}

/** Snake_case, like the rest of this plane: the row mirrors the stored thread. */
function threadRow(thread: Awaited<ReturnType<typeof queryThreads>>[number]) {
  return {
    id: thread.id,
    title: thread.title ?? null,
    created_at: thread.createdAt.toISOString(),
    updated_at: thread.updatedAt.toISOString(),
    // The resource is echoed so the console can tell "my other device" from
    // "another user in my tenant"; it is never a filter the client controls.
    resource_id: thread.resourceId,
  }
}

export function createAgentRouter(deps: AgentRouterDeps): Hono {
  const { env } = deps
  const agentId = deps.agentId ?? CRUM_AGENT_CONTROLLER_ID
  const app = new Hono().basePath('/api/agent')

  const auth = async (c: Context) => {
    try {
      return { identity: await resolveIdentity((name) => c.req.header(name), env) }
    } catch (err) {
      if (err instanceof IdentityError) {
        return { error: c.json({ error: 'unauthorized', reason: err.reason }, 401) }
      }
      throw err
    }
  }

  app.get('/threads', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const mastra = deps.getMastra?.() ?? null
    if (!mastra) {
      return c.json(
        { error: 'agent-not-wired', detail: 'This router was created without getMastra, so threads cannot be read from storage.' },
        503,
      )
    }

    // The resource is derived from the verified identity and nothing else. There
    // is no query parameter for it: accepting one would let any signed-in user
    // name another user's `tenant:userId` resource and read their conversation
    // titles, which is exactly what the storage filter is relied upon to prevent.
    const resourceId = resourceIdFor(gate.identity)

    let threads
    try {
      threads = await queryThreads(mastra, { agentId, resourceId })
    } catch (err) {
      // `queryThreads` throws when no AgentController is registered under the
      // key, which is a deployment fault rather than a client mistake.
      const detail = err instanceof Error ? err.message : String(err)
      return c.json({ error: 'controller-missing', detail }, 503)
    }

    // Belt to the storage filter above: a row from another resource should be
    // impossible, and is dropped rather than shown if it somehow appears.
    const rows = (threads ?? [])
      .filter((thread) => thread.resourceId === resourceId)
      .map(threadRow)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))

    return c.json({ sessions: rows, total: rows.length })
  })

  return app
}
