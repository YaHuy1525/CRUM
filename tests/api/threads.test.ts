// tests/api/threads.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'
import type { Mastra } from '@mastra/core/mastra'
import type { MastraDBMessage } from '@mastra/core/agent/message-list'
import { createThreadsRouter, type ConversationMemory, type StoredThread } from '../../src/api/threads'
import { parseEnv } from '../../src/config/env'

/**
 * The conversation read-and-manage router. The property that matters most is
 * scoping: every route derives the caller's resource from the verified identity,
 * fetches with it, re-checks the row against it, and answers a cross-user or
 * missing thread as `404 not_found` — never as data, never as a distinguishable
 * "exists but not yours". The memory layer is stubbed here (it is exercised for
 * real against storage elsewhere), so this file is about the route contract.
 */

const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const USER = '660e8400-e29b-41d4-a716-446655440009'
const RESOURCE = `${TENANT}:${USER}`
const OTHER_RESOURCE = `${TENANT}:someone-else`
const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

const AT = new Date('2026-10-20T09:00:00.000Z')

type MemoryStub = {
  getThreadById: ReturnType<typeof vi.fn>
  recall: ReturnType<typeof vi.fn>
  updateThread: ReturnType<typeof vi.fn>
  deleteThread: ReturnType<typeof vi.fn>
  searchMessages: ReturnType<typeof vi.fn>
}

function makeMemory(): MemoryStub {
  return {
    getThreadById: vi.fn(),
    recall: vi.fn(),
    updateThread: vi.fn(),
    deleteThread: vi.fn(),
    searchMessages: vi.fn(),
  }
}

function storedThread(over: Partial<StoredThread> = {}): StoredThread {
  return {
    id: 't1',
    title: 'Q3 pipeline',
    resourceId: RESOURCE,
    createdAt: AT,
    updatedAt: AT,
    metadata: {},
    ...over,
  }
}

function storedMessage(text: string, over: Partial<MastraDBMessage> = {}): MastraDBMessage {
  return {
    id: 'm1',
    role: 'user',
    createdAt: AT,
    content: { format: 2, parts: [{ type: 'text', text }] },
    ...over,
  } as unknown as MastraDBMessage
}

function router(memory: ConversationMemory | null): Hono {
  const mastra = { getMemory: () => memory } as unknown as Mastra
  return createThreadsRouter({ env: parseEnv({}), getMastra: () => mastra })
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}

let memory: MemoryStub

beforeEach(() => {
  memory = makeMemory()
  memory.getThreadById.mockResolvedValue(storedThread())
  memory.recall.mockResolvedValue({ messages: [], total: 0, page: 0, perPage: 50, hasMore: false })
  memory.searchMessages.mockResolvedValue({ results: [] })
  memory.deleteThread.mockResolvedValue(undefined)
  // updateThread echoes the patch back onto the stored thread.
  memory.updateThread.mockImplementation((args: { id: string; title?: string; metadata?: Record<string, unknown> }) =>
    storedThread({ id: args.id, title: args.title, metadata: args.metadata }),
  )
})

const mem = () => memory as unknown as ConversationMemory

describe('GET /api/agent/threads/:id', () => {
  it('refuses a bare x-tenant-id header instead of trusting it', async () => {
    const res = await router(mem()).request('/api/agent/threads/t1', { headers: { 'x-tenant-id': TENANT } })
    expect(res.status).toBe(401)
    expect(memory.getThreadById).not.toHaveBeenCalled()
  })

  it('scopes the lookup to the caller-derived resource and ignores a client-supplied one', async () => {
    const res = await router(mem()).request('/api/agent/threads/t1?resourceId=other%3Auser', { headers: AUTH })
    expect(res.status).toBe(200)
    expect(memory.getThreadById).toHaveBeenCalledWith({ threadId: 't1', resourceId: RESOURCE })
  })

  it('returns the thread row', async () => {
    const row = await json<Record<string, unknown>>(router(mem()).request('/api/agent/threads/t1', { headers: AUTH }))
    expect(row).toMatchObject({ id: 't1', title: 'Q3 pipeline', resource_id: RESOURCE, title_pinned: false })
    expect(row.created_at).toBe('2026-10-20T09:00:00.000Z')
  })

  it('answers a cross-user thread as 404, never as data', async () => {
    memory.getThreadById.mockResolvedValue(storedThread({ resourceId: OTHER_RESOURCE }))
    const res = await router(mem()).request('/api/agent/threads/t1', { headers: AUTH })
    expect(res.status).toBe(404)
    expect(await json(res)).toEqual({ error: 'not_found' })
  })

  it('answers a missing thread as 404', async () => {
    memory.getThreadById.mockResolvedValue(null)
    const res = await router(mem()).request('/api/agent/threads/nope', { headers: AUTH })
    expect(res.status).toBe(404)
    expect(await json(res)).toEqual({ error: 'not_found' })
  })

  it('answers 503 when no instance is wired', async () => {
    const res = await createThreadsRouter({ env: parseEnv({}), getMastra: () => null }).request('/api/agent/threads/t1', {
      headers: AUTH,
    })
    expect(res.status).toBe(503)
    expect((await json<{ error: string }>(res)).error).toBe('agent-not-wired')
  })

  it('answers 503 when no memory is registered', async () => {
    const res = await router(null).request('/api/agent/threads/t1', { headers: AUTH })
    expect(res.status).toBe(503)
    expect((await json<{ error: string }>(res)).error).toBe('memory-not-wired')
  })
})

describe('GET /api/agent/threads/:id/messages', () => {
  it('owner-checks before recalling: a cross-user thread never reaches recall', async () => {
    memory.getThreadById.mockResolvedValue(storedThread({ resourceId: OTHER_RESOURCE }))
    const res = await router(mem()).request('/api/agent/threads/t1/messages', { headers: AUTH })
    expect(res.status).toBe(404)
    expect(memory.recall).not.toHaveBeenCalled()
  })

  it('applies pagination defaults (page 1, perPage 50) and passes a zero-indexed page to recall', async () => {
    const res = await router(mem()).request('/api/agent/threads/t1/messages', { headers: AUTH })
    expect(res.status).toBe(200)
    expect(memory.recall).toHaveBeenCalledWith({ threadId: 't1', resourceId: RESOURCE, page: 0, perPage: 50, hideSignals: true })
    const body = await json<{ page: number; perPage: number }>(res)
    expect(body.page).toBe(1)
    expect(body.perPage).toBe(50)
  })

  it('caps perPage at 200 and floors page at 1', async () => {
    await router(mem()).request('/api/agent/threads/t1/messages?perPage=5000&page=0', { headers: AUTH })
    expect(memory.recall).toHaveBeenCalledWith(
      expect.objectContaining({ page: 0, perPage: 200 }),
    )
  })

  it('falls back to defaults on non-numeric query values', async () => {
    await router(mem()).request('/api/agent/threads/t1/messages?perPage=abc&page=xyz', { headers: AUTH })
    expect(memory.recall).toHaveBeenCalledWith(expect.objectContaining({ page: 0, perPage: 50 }))
  })

  it('maps stored messages and passes pagination through', async () => {
    memory.recall.mockResolvedValue({
      messages: [storedMessage('hello'), storedMessage('world', { id: 'm2', role: 'assistant' })],
      total: 2,
      page: 0,
      perPage: 50,
      hasMore: false,
    })
    const body = await json<{ messages: Array<{ id: string; role: string; parts: unknown[] }>; total: number; hasMore: boolean; trace_available: boolean }>(
      router(mem()).request('/api/agent/threads/t1/messages', { headers: AUTH }),
    )
    expect(body.total).toBe(2)
    expect(body.hasMore).toBe(false)
    expect(body.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(body.messages[0]!.parts).toEqual([{ type: 'text', text: 'hello' }])
    expect(body.trace_available).toBe(false)
  })

  it('reports trace_available true when a stored message carries a trace id', async () => {
    memory.recall.mockResolvedValue({
      messages: [
        { ...storedMessage('x'), content: { format: 2, parts: [{ type: 'text', text: 'x' }], metadata: { traceId: 'tr_1' } } } as unknown as MastraDBMessage,
      ],
      total: 1,
      page: 0,
      perPage: 50,
      hasMore: false,
    })
    const body = await json<{ trace_available: boolean }>(router(mem()).request('/api/agent/threads/t1/messages', { headers: AUTH }))
    expect(body.trace_available).toBe(true)
  })
})

describe('PATCH /api/agent/threads/:id', () => {
  it('owner-checks first: a cross-user thread is 404 and never updated', async () => {
    memory.getThreadById.mockResolvedValue(storedThread({ resourceId: OTHER_RESOURCE }))
    const res = await router(mem()).request('/api/agent/threads/t1', {
      method: 'PATCH',
      headers: AUTH,
      body: JSON.stringify({ title: 'Hijacked', source: 'user' }),
    })
    expect(res.status).toBe(404)
    expect(memory.updateThread).not.toHaveBeenCalled()
  })

  it('source "user" sets the title and pins it', async () => {
    const res = await router(mem()).request('/api/agent/threads/t1', {
      method: 'PATCH',
      headers: AUTH,
      body: JSON.stringify({ title: 'Renewal for Acme', source: 'user' }),
    })
    expect(res.status).toBe(200)
    expect(memory.updateThread).toHaveBeenCalledWith({
      id: 't1',
      title: 'Renewal for Acme',
      metadata: { titlePinned: true },
    })
    expect((await json<{ title_pinned: boolean }>(res)).title_pinned).toBe(true)
  })

  it('source "user" rejects an empty title with 400', async () => {
    const res = await router(mem()).request('/api/agent/threads/t1', {
      method: 'PATCH',
      headers: AUTH,
      body: JSON.stringify({ title: '   ', source: 'user' }),
    })
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toBe('invalid_title')
    expect(memory.updateThread).not.toHaveBeenCalled()
  })

  it('rejects a malformed body with 400', async () => {
    const res = await router(mem()).request('/api/agent/threads/t1', {
      method: 'PATCH',
      headers: AUTH,
      body: JSON.stringify({ title: 'ok' }),
    })
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toBe('invalid_body')
  })

  it('source "auto" applies to an empty, unpinned title without pinning', async () => {
    memory.getThreadById.mockResolvedValue(storedThread({ title: '', metadata: {} }))
    const res = await router(mem()).request('/api/agent/threads/t1', {
      method: 'PATCH',
      headers: AUTH,
      body: JSON.stringify({ title: 'First user message…', source: 'auto' }),
    })
    expect(res.status).toBe(200)
    expect(memory.updateThread).toHaveBeenCalledWith({ id: 't1', title: 'First user message…' })
  })

  it('source "auto" refuses to overwrite a non-empty title', async () => {
    memory.getThreadById.mockResolvedValue(storedThread({ title: 'Already named', metadata: {} }))
    const res = await router(mem()).request('/api/agent/threads/t1', {
      method: 'PATCH',
      headers: AUTH,
      body: JSON.stringify({ title: 'Auto name', source: 'auto' }),
    })
    expect(res.status).toBe(200)
    expect(memory.updateThread).not.toHaveBeenCalled()
    expect((await json<{ title: string }>(res)).title).toBe('Already named')
  })

  it('source "auto" refuses a pinned title even when the title text is empty', async () => {
    memory.getThreadById.mockResolvedValue(storedThread({ title: '', metadata: { titlePinned: true } }))
    const res = await router(mem()).request('/api/agent/threads/t1', {
      method: 'PATCH',
      headers: AUTH,
      body: JSON.stringify({ title: 'Auto name', source: 'auto' }),
    })
    expect(res.status).toBe(200)
    expect(memory.updateThread).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/agent/threads/:id', () => {
  it('owner-checks then deletes', async () => {
    const res = await router(mem()).request('/api/agent/threads/t1', { method: 'DELETE', headers: AUTH })
    expect(res.status).toBe(200)
    expect(memory.getThreadById).toHaveBeenCalledWith({ threadId: 't1', resourceId: RESOURCE })
    expect(memory.deleteThread).toHaveBeenCalledWith('t1')
    expect(await json(res)).toEqual({ ok: true, id: 't1' })
  })

  it('refuses a cross-user thread and never deletes', async () => {
    memory.getThreadById.mockResolvedValue(storedThread({ resourceId: OTHER_RESOURCE }))
    const res = await router(mem()).request('/api/agent/threads/t1', { method: 'DELETE', headers: AUTH })
    expect(res.status).toBe(404)
    expect(memory.deleteThread).not.toHaveBeenCalled()
  })

  it('refuses a missing thread', async () => {
    memory.getThreadById.mockResolvedValue(null)
    const res = await router(mem()).request('/api/agent/threads/nope', { method: 'DELETE', headers: AUTH })
    expect(res.status).toBe(404)
    expect(memory.deleteThread).not.toHaveBeenCalled()
  })
})

describe('GET /api/agent/search', () => {
  it('rejects a missing query with 400', async () => {
    const res = await router(mem()).request('/api/agent/search', { headers: AUTH })
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toBe('query_required')
    expect(memory.searchMessages).not.toHaveBeenCalled()
  })

  it('rejects a blank query with 400', async () => {
    const res = await router(mem()).request('/api/agent/search?query=%20%20', { headers: AUTH })
    expect(res.status).toBe(400)
    expect(memory.searchMessages).not.toHaveBeenCalled()
  })

  it('scopes the search to the caller-derived resource with topK 20, ignoring a client resourceId', async () => {
    const res = await router(mem()).request('/api/agent/search?query=acme&resourceId=other%3Auser', { headers: AUTH })
    expect(res.status).toBe(200)
    expect(memory.searchMessages).toHaveBeenCalledWith({ query: 'acme', resourceId: RESOURCE, topK: 20 })
  })

  it('maps results to hits', async () => {
    memory.searchMessages.mockResolvedValue({
      results: [{ threadId: 't9', score: 0.82, text: '…acme renewal…', observedAt: AT }],
    })
    const body = await json<{ hits: Array<Record<string, unknown>> }>(
      router(mem()).request('/api/agent/search?query=acme', { headers: AUTH }),
    )
    expect(body.hits).toEqual([
      { thread_id: 't9', snippet: '…acme renewal…', score: 0.82, created_at: '2026-10-20T09:00:00.000Z' },
    ])
  })

  it('answers 401 without identity', async () => {
    const res = await router(mem()).request('/api/agent/search?query=acme')
    expect(res.status).toBe(401)
  })
})
