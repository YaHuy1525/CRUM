// tests/api/agent.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'
import type { Mastra } from '@mastra/core/mastra'

/**
 * `GET /api/agent/threads` is the route that replaces the mock array in
 * `SessionList.tsx`, so the contract it has to honour is: my conversations,
 * newest first, and a failure that looks different from an empty list.
 *
 * `queryThreads` is mocked here (it is exercised for real, against an
 * `InMemoryStore`, by tests/mastra/sessions.test.ts and the acceptance timing
 * test), which keeps this file about the route: what it filters, what it echoes,
 * and what it does when the registry is not there.
 */
const sessions = vi.hoisted(() => ({ queryThreads: vi.fn() }))

vi.mock('../../src/mastra/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mastra/sessions')>()
  return { ...actual, ...sessions }
})

import { createAgentRouter } from '../../src/api/agent'
import { parseEnv } from '../../src/config/env'

const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const USER = '660e8400-e29b-41d4-a716-446655440009'
const RESOURCE = `${TENANT}:${USER}`
const OTHER_RESOURCE = `${TENANT}:${'someone-else'}`

const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

interface ThreadRow {
  id: string
  title: string | null
  created_at: string
  updated_at: string
  resource_id: string
}

/** Stored threads come back as Dates; the route is what turns them into strings. */
function thread(id: string, updatedDaysAgo: number, over: Partial<{ title: string; resourceId: string }> = {}): {
  id: string
  resourceId: string
  title?: string
  createdAt: Date
  updatedAt: Date
} {
  const at = new Date(Date.UTC(2026, 9, 20 - updatedDaysAgo, 9, 0, 0)).toISOString()
  return { id, resourceId: over.resourceId ?? RESOURCE, title: over.title, createdAt: new Date(at), updatedAt: new Date(at) }
}

function router(getMastra?: () => Mastra | null): Hono {
  return createAgentRouter({
    env: parseEnv({}),
    getMastra: getMastra ?? (() => ({ not: 'a real mastra' }) as unknown as Mastra),
  })
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}

beforeEach(() => {
  vi.clearAllMocks()
  sessions.queryThreads.mockResolvedValue([])
})

describe('GET /api/agent/threads', () => {
  it('refuses a bare x-tenant-id header instead of trusting it', async () => {
    const res = await router().request('/api/agent/threads', { headers: { 'x-tenant-id': TENANT } })

    expect(res.status).toBe(401)
    expect(sessions.queryThreads).not.toHaveBeenCalled()
  })

  it('asks storage only for the caller\'s own resource', async () => {
    await router().request('/api/agent/threads', { headers: AUTH })

    expect(sessions.queryThreads).toHaveBeenCalledWith(expect.anything(), {
      agentId: 'crm-assistant',
      resourceId: RESOURCE,
    })
  })

  it('names the newest conversation first and never filters by a client-supplied resource', async () => {
    sessions.queryThreads.mockResolvedValue([
      thread('t-old', 3, { title: 'Q3 pipeline' }),
      thread('t-new', 0, { title: 'Renewal for Acme' }),
      thread('t-mid', 1),
    ])

    const res = await router().request('/api/agent/threads?resourceId=other%3Auser', { headers: AUTH })
    const list = await json<{ sessions: ThreadRow[]; total: number }>(res)

    expect(res.status).toBe(200)
    expect(list.sessions.map((s) => s.id)).toEqual(['t-new', 't-mid', 't-old'])
    // The sidebar needs a label, and a thread can be untitled.
    expect(list.sessions[1]!.title).toBeNull()
    expect(list.sessions[0]).toMatchObject({ resource_id: RESOURCE })
    expect(typeof list.sessions[0]!.updated_at).toBe('string')
    // The ignored parameter must not have reached storage.
    expect(sessions.queryThreads.mock.calls[0]![1]).toEqual({ agentId: 'crm-assistant', resourceId: RESOURCE })
  })

  it('drops a row that came back under another resource', async () => {
    // Should be impossible — the storage filter is exact — but a leak here would
    // show someone else's conversation title in this user's sidebar.
    sessions.queryThreads.mockResolvedValue([thread('t-mine', 0), thread('t-theirs', 1, { resourceId: OTHER_RESOURCE })])

    const list = await json<{ sessions: ThreadRow[]; total: number }>(
      router().request('/api/agent/threads', { headers: AUTH }),
    )

    expect(list.total).toBe(1)
    expect(list.sessions.map((s) => s.id)).toEqual(['t-mine'])
  })

  it('answers an empty list as an empty list, so the console can say "no sessions yet"', async () => {
    const empty = await json<{ sessions: unknown[]; total: number }>(
      router().request('/api/agent/threads', { headers: AUTH }),
    )

    expect(empty).toEqual({ sessions: [], total: 0 })
  })

  it('answers 503 when no instance is wired', async () => {
    const res = await router(() => null).request('/api/agent/threads', { headers: AUTH })

    expect(res.status).toBe(503)
    expect((await json<{ error?: string }>(res)).error).toBe('agent-not-wired')
  })

  it('reports a missing controller as the deployment fault it is', async () => {
    sessions.queryThreads.mockRejectedValue(new Error('no AgentController registered under key "crm-assistant"'))

    const res = await router().request('/api/agent/threads', { headers: AUTH })

    expect(res.status).toBe(503)
    expect((await json<{ error?: string; detail?: string }>(res)).detail).toMatch(/AgentController/)
  })
})
