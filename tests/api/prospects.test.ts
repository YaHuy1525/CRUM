// tests/api/prospects.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

/**
 * The duplicate-resolution route is a staging surface, not a merge.
 *
 * The console cannot call the agent tool directly, so `POST
 * /api/prospects/merge-candidates/:id` exists to put the operator's decision in
 * the approval queue. What must hold:
 *
 * 1. Nothing is resolved here. The only write is `getOrCreateDraft`, and it is
 *    always `prospect_merge` / `update` / gate `approval` keyed by
 *    candidate + survivor + decision, so a double submit is the same draft.
 * 2. A malformed decision is a 400 before any row is written.
 * 3. The console posts a native URL-encoded form, not JSON, and both shapes must
 *    arrive as the same two fields.
 *
 * The DB modules are mocked, so no DATABASE_URL and no Postgres.
 */
const db = vi.hoisted(() => ({
  queryProspects: vi.fn(),
  queryProspect: vi.fn(),
  listMergeCandidates: vi.fn(),
  getOrCreateDraft: vi.fn(),
}))

vi.mock('../../src/db/prospect-queries', () => ({
  queryProspects: db.queryProspects,
  queryProspect: db.queryProspect,
}))

vi.mock('../../src/db/prospect-merge', () => ({
  listMergeCandidates: db.listMergeCandidates,
}))

vi.mock('../../src/db/pending-writes', () => ({
  getOrCreateDraft: db.getOrCreateDraft,
}))

import { createProspectsRouter } from '../../src/api/prospects'
import { parseEnv } from '../../src/config/env'

const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const USER = '660e8400-e29b-41d4-a716-446655440009'
const CANDIDATE = '770e8400-e29b-41d4-a716-446655440003'
const SURVIVOR = '880e8400-e29b-41d4-a716-446655440007'
const DRAFT = 'aa0e8400-e29b-41d4-a716-446655440001'

const AUTH = {
  'x-tenant-id': TENANT,
  'x-user-id': USER,
  'x-user-role': 'user',
}

function router(): Hono {
  return createProspectsRouter({ env: parseEnv({}) })
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return router().request(`/api/prospects/merge-candidates/${CANDIDATE}`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}

beforeEach(() => {
  vi.clearAllMocks()
  db.getOrCreateDraft.mockResolvedValue({ id: DRAFT, gate: 'approval' })
})

describe('POST /api/prospects/merge-candidates/:id', () => {
  it('stages a merge decision instead of merging', async () => {
    const res = await post({ survivorId: SURVIVOR, decision: 'merge' })
    expect(res.status).toBe(201)

    expect(db.getOrCreateDraft).toHaveBeenCalledTimes(1)
    expect(db.getOrCreateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        runId: 'pending',
        objectType: 'prospect_merge',
        operation: 'update',
        targetId: CANDIDATE,
        payload: { candidateId: CANDIDATE, survivorId: SURVIVOR, decision: 'merge' },
        gate: 'approval',
        requestedBy: USER,
        idempotencyKey: `merge:${CANDIDATE}:${SURVIVOR}:merge`,
      }),
    )

    const body = await json<{ pendingWriteId: string; message: string }>(res)
    expect(body.pendingWriteId).toBe(DRAFT)
    expect(body.message).toContain('/approvals')
  })

  it('accepts the console form as URL-encoded fields', async () => {
    const res = await router().request(`/api/prospects/merge-candidates/${CANDIDATE}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ survivorId: SURVIVOR, decision: 'dismiss' }).toString(),
    })
    expect(res.status).toBe(201)

    expect(db.getOrCreateDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { candidateId: CANDIDATE, survivorId: SURVIVOR, decision: 'dismiss' },
        idempotencyKey: `merge:${CANDIDATE}:${SURVIVOR}:dismiss`,
      }),
    )
  })

  it('refuses an unknown decision before staging anything', async () => {
    const res = await post({ survivorId: SURVIVOR, decision: 'skip' })

    expect(res.status).toBe(400)
    expect((await json<{ error?: string }>(res)).error).toBe('invalid_query')
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
  })

  it('refuses a survivorId that is not a uuid', async () => {
    const res = await post({ survivorId: 'survivor-left', decision: 'merge' })

    expect(res.status).toBe(400)
    expect((await json<{ error?: string }>(res)).error).toBe('invalid_query')
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
  })

  it('refuses a candidate id that is not a uuid', async () => {
    const res = await router().request('/api/prospects/merge-candidates/merge-me', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ survivorId: SURVIVOR, decision: 'merge' }),
    })

    expect(res.status).toBe(400)
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
  })

  it('requires identity before reading the body', async () => {
    const res = await router().request(`/api/prospects/merge-candidates/${CANDIDATE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ survivorId: SURVIVOR, decision: 'merge' }),
    })

    expect(res.status).toBe(401)
    expect(db.getOrCreateDraft).not.toHaveBeenCalled()
  })
})
