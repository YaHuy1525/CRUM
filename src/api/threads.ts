import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { Mastra } from '@mastra/core/mastra'
import type { CrumEnv } from '../config/env'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import { resourceIdFor } from '../mastra/sessions'
import { mapRecallPage, type RecallPage } from './message-mapping'


const CORE_MEMORY_KEY = 'coreMemory'

export interface StoredThread {
  id: string
  title?: string
  resourceId: string
  createdAt: Date
  updatedAt: Date
  metadata?: Record<string, unknown>
}

export interface SearchHit {
  threadId: string
  score: number
  text?: string
  observedAt?: Date
}

export interface ConversationMemory {
  getThreadById(args: { threadId: string; resourceId?: string }): Promise<StoredThread | null>
  recall(args: {
    threadId: string
    resourceId?: string
    page?: number
    perPage?: number | false
    hideSignals?: boolean
  }): Promise<RecallPage>
  updateThread(args: { id: string; title?: string; metadata?: Record<string, unknown> }): Promise<StoredThread>
  deleteThread(threadId: string): Promise<void>
  searchMessages(args: { query: string; resourceId: string; topK?: number }): Promise<{ results: SearchHit[] }>
}

export interface ThreadsRouterDeps {
  env: CrumEnv
  getMastra?: () => Mastra | null
}

const PatchBody = z.object({
  title: z.string(),
  source: z.enum(['user', 'auto']),
})

const DEFAULT_PAGE = 1
const DEFAULT_PER_PAGE = 50
const MAX_PER_PAGE = 200

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function threadRow(thread: StoredThread) {
  return {
    id: thread.id,
    title: thread.title ?? null,
    created_at: thread.createdAt instanceof Date ? thread.createdAt.toISOString() : String(thread.createdAt ?? ''),
    updated_at: thread.updatedAt instanceof Date ? thread.updatedAt.toISOString() : String(thread.updatedAt ?? ''),
    resource_id: thread.resourceId,
    title_pinned: thread.metadata?.titlePinned === true,
  }
}

export function createThreadsRouter(deps: ThreadsRouterDeps): Hono {
  const { env } = deps
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

  const readMemory = (mastra: Mastra): ConversationMemory | null => {
    try {
      const memory = mastra.getMemory(CORE_MEMORY_KEY)
      return (memory as unknown as ConversationMemory) ?? null
    } catch {
      return null
    }
  }

  const loadOwnedThread = async (c: Context, threadId: string) => {
    const gate = await auth(c)
    if ('error' in gate) return { response: gate.error }

    const mastra = deps.getMastra?.() ?? null
    if (!mastra) {
      return {
        response: c.json(
          { error: 'agent-not-wired', detail: 'This router was created without getMastra, so conversations cannot be read from storage.' },
          503,
        ),
      }
    }

    const memory = readMemory(mastra)
    if (!memory) {
      return {
        response: c.json(
          { error: 'memory-not-wired', detail: `No Memory is registered under "${CORE_MEMORY_KEY}".` },
          503,
        ),
      }
    }

    const resourceId = resourceIdFor(gate.identity)

    const thread = await memory.getThreadById({ threadId, resourceId })
    if (!thread || thread.resourceId !== resourceId) {
      return { response: c.json({ error: 'not_found' }, 404) }
    }

    return { resourceId, memory, thread }
  }

  app.get('/threads/:id', async (c) => {
    const owned = await loadOwnedThread(c, c.req.param('id'))
    if ('response' in owned) return owned.response
    return c.json(threadRow(owned.thread))
  })

  app.get('/threads/:id/messages', async (c) => {
    const threadId = c.req.param('id')
    const owned = await loadOwnedThread(c, threadId)
    if ('response' in owned) return owned.response

    const page = clampInt(c.req.query('page'), DEFAULT_PAGE, 1, Number.MAX_SAFE_INTEGER)
    const perPage = clampInt(c.req.query('perPage'), DEFAULT_PER_PAGE, 1, MAX_PER_PAGE)

    const recalled = await owned.memory.recall({
      threadId,
      resourceId: owned.resourceId,
      page: page - 1,
      perPage,
      hideSignals: true,
    })

    const mapped = mapRecallPage(recalled)
    return c.json({
      messages: mapped.messages,
      total: mapped.total,
      page,
      perPage,
      hasMore: mapped.hasMore,
      trace_available: mapped.trace_available,
    })
  })

  app.patch('/threads/:id', async (c) => {
    const owned = await loadOwnedThread(c, c.req.param('id'))
    if ('response' in owned) return owned.response

    const body = await c.req.json<unknown>().catch(() => null)
    const parsed = PatchBody.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
    }

    const { source } = parsed.data
    const title = parsed.data.title.trim()
    const storedTitle = owned.thread.title?.trim() ?? ''
    const pinned = owned.thread.metadata?.titlePinned === true

    if (source === 'user') {
      if (title === '') {
        return c.json({ error: 'invalid_title', detail: 'title must not be empty for source "user"' }, 400)
      }
      const updated = await owned.memory.updateThread({
        id: owned.thread.id,
        title,
        metadata: { ...owned.thread.metadata, titlePinned: true },
      })
      return c.json(threadRow(updated))
    }

    if (storedTitle !== '' || pinned) {
      return c.json(threadRow(owned.thread))
    }
    if (title === '') {
      return c.json(threadRow(owned.thread))
    }
    const updated = await owned.memory.updateThread({ id: owned.thread.id, title })
    return c.json(threadRow(updated))
  })

  app.delete('/threads/:id', async (c) => {
    const owned = await loadOwnedThread(c, c.req.param('id'))
    if ('response' in owned) return owned.response

    await owned.memory.deleteThread(owned.thread.id)
    return c.json({ ok: true, id: owned.thread.id })
  })

  app.get('/search', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const query = c.req.query('query')
    if (!query || query.trim() === '') {
      return c.json({ error: 'query_required', detail: 'query must be a non-empty string' }, 400)
    }

    const mastra = deps.getMastra?.() ?? null
    if (!mastra) {
      return c.json(
        { error: 'agent-not-wired', detail: 'This router was created without getMastra, so conversations cannot be searched.' },
        503,
      )
    }

    const memory = readMemory(mastra)
    if (!memory) {
      return c.json({ error: 'memory-not-wired', detail: `No Memory is registered under "${CORE_MEMORY_KEY}".` }, 503)
    }

    // searchMessages needs the semantic-recall vector lane; with
    // CRUM_RECALL_ENABLED=false (or no DATABASE_URL) no store is attached and
    // the framework throws (src-DxZ7N8nO.js:43716). 503 beats a 500 for a
    // documented, deliberate kill-switch combination.
    if (!(memory as { vector?: unknown }).vector) {
      return c.json(
        {
          error: 'search-unavailable',
          detail: 'Message search requires the semantic-recall vector lane (CRUM_RECALL_ENABLED=false).',
        },
        503,
      )
    }

    const resourceId = resourceIdFor(gate.identity)
    const found = await memory.searchMessages({ query: query.trim(), resourceId, topK: 20 })

    const hits = (found.results ?? []).map((hit) => ({
      thread_id: hit.threadId,
      snippet: hit.text ?? '',
      score: hit.score,
      created_at: hit.observedAt ? new Date(hit.observedAt).toISOString() : null,
    }))

    return c.json({ hits })
  })

  return app
}
