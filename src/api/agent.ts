import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Mastra } from '@mastra/core/mastra'
import type { CrumEnv } from '../config/env'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import { CRUM_AGENT_CONTROLLER_ID, queryThreads, resourceIdFor } from '../mastra/sessions'

export interface AgentRouterDeps {
  env: CrumEnv
  getMastra?: () => Mastra | null
  agentId?: string
}

function threadRow(thread: Awaited<ReturnType<typeof queryThreads>>[number]) {
  return {
    id: thread.id,
    title: thread.title ?? null,
    created_at: thread.createdAt.toISOString(),
    updated_at: thread.updatedAt.toISOString(),
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

    const resourceId = resourceIdFor(gate.identity)

    let threads
    try {
      threads = await queryThreads(mastra, { agentId, resourceId })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return c.json({ error: 'controller-missing', detail }, 503)
    }

    const rows = (threads ?? [])
      .filter((thread) => thread.resourceId === resourceId)
      .map(threadRow)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))

    return c.json({ sessions: rows, total: rows.length })
  })

  return app
}
