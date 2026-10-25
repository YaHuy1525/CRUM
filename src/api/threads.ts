// src/api/threads.ts
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { Mastra } from '@mastra/core/mastra'
import type { CrumEnv } from '../config/env'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import { resourceIdFor } from '../mastra/sessions'
import { mapRecallPage, type RecallPage } from './message-mapping'

/**
 * Conversation read-and-manage plane. §Chats/Backend.
 *
 * The existing agent router lists the caller's threads; this router makes one
 * conversation readable and manageable: fetch its metadata, page through its
 * stored transcript (converted to the chat-UI shape by `message-mapping`),
 * rename it, delete it, and search across it.
 *
 * Scoping mirrors `src/api/agent.ts` exactly, because a thread id is a bearer
 * token if it is the only thing checked:
 * - identity is resolved from the request (dev headers or a verified JWT),
 * - `resourceId` is derived server-side from that identity via `resourceIdFor`,
 * - no client-supplied `resourceId` is ever read,
 * - every thread is fetched with `getThreadById({ threadId, resourceId })` AND
 *   re-checked against the caller's resource before any data is returned, so a
 *   cross-user or missing id answers `404 not_found` — never a leak, never a
 *   distinguishable "exists but not yours".
 *
 * `searchMessages` is scoped by passing `resourceId` to the memory layer; it
 * returns no per-hit resource to re-filter on, so the server-side scope is the
 * isolation boundary (the same defense the thread list already relies on).
 */

/** Registry key of the Memory instance registered in `createCrumMastra`. */
const CORE_MEMORY_KEY = 'coreMemory'

/** The stored thread row shape `Memory.getThreadById` / `updateThread` resolve to. */
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

/**
 * The slice of the pinned `Memory` class this router uses. Declared structurally
 * (rather than importing the concrete class) because `mastra.getMemory` is typed
 * to the abstract `MastraMemory`, whose `getThreadById` omits the `resourceId`
 * parameter and which does not declare `searchMessages` at all — both of which
 * the concrete class does have. The cast lives in one place, `readMemory`.
 */
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
  /** Null before the Mastra registry exists, answered as a real 503. */
  getMastra?: () => Mastra | null
}

const PatchBody = z.object({
  title: z.string(),
  source: z.enum(['user', 'auto']),
})

/** Page defaults and caps for the messages route. */
const DEFAULT_PAGE = 1
const DEFAULT_PER_PAGE = 50
const MAX_PER_PAGE = 200

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** Snake_case, like the rest of this plane: the row mirrors the stored thread. */
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

  /**
   * Resolve the memory instance, or null. Kept separate from `getMastra` so the
   * two wiring faults (no instance vs. no memory registered) answer differently.
   */
  const readMemory = (mastra: Mastra): ConversationMemory | null => {
    try {
      const memory = mastra.getMemory(CORE_MEMORY_KEY)
      return (memory as unknown as ConversationMemory) ?? null
    } catch {
      return null
    }
  }

  /**
   * Shared preamble: authenticate, require the instance and its memory, derive
   * the caller's resource, and load + owner-check the thread. Returns either a
   * ready `{ resourceId, memory, thread }` or a JSON error response to return.
   */
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

    // Derived from the verified identity, never from a client parameter.
    const resourceId = resourceIdFor(gate.identity)

    const thread = await memory.getThreadById({ threadId, resourceId })
    // Belt to the storage filter: a row from another resource is 404, not data.
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

    // `recall` pages are zero-indexed; the caller's page is one-indexed.
    const recalled = await owned.memory.recall({
      threadId,
      resourceId: owned.resourceId,
      page: page - 1,
      perPage,
      // System reminders and reactive signals are plumbing, not transcript.
      hideSignals: true,
    })

    const mapped = mapRecallPage(recalled)
    return c.json({
      messages: mapped.messages,
      total: mapped.total,
      // Report the caller's one-indexed page, not recall's zero-indexed echo.
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
      // A manual rename must carry a name; an empty title is a client mistake.
      if (title === '') {
        return c.json({ error: 'invalid_title', detail: 'title must not be empty for source "user"' }, 400)
      }
      // Pin so a later auto-title never overwrites a name the user chose.
      const updated = await owned.memory.updateThread({
        id: owned.thread.id,
        title,
        metadata: { ...owned.thread.metadata, titlePinned: true },
      })
      return c.json(threadRow(updated))
    }

    // source === 'auto': apply only to an unnamed, unpinned thread. Otherwise it
    // is a no-op and the current title stands — auto-titling never clobbers.
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
