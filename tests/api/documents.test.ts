// tests/api/documents.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

/**
 * The structured business-document routes, exercised over real HTTP.
 *
 * The upload route is asserted at the seam that matters: it must hand the intake
 * workflow the base64 bytes, the resolved tenant/owner, and a request context that
 * carries `tenantId` (the ingest step's vector resolver refuses without it), and it
 * must report the workflow's own status rather than pretending. The read and review
 * routes are pinned to the tenant predicate — a uuid alone must never resolve
 * another tenant's document.
 */
interface FakeResult {
  rows: unknown[]
  rowCount: number
}

const db = vi.hoisted((): { calls: { sql: string; params: unknown[] }[]; results: Record<string, FakeResult> } => ({
  calls: [],
  results: {},
}))

vi.mock('../../src/db/client', () => ({
  getDbClient: () => ({
    query: (sql: string, params?: unknown[]): Promise<FakeResult> => {
      db.calls.push({ sql, params: params ?? [] })
      const key = Object.keys(db.results).find((needle) => sql.includes(needle))
      const hit = key ? db.results[key] : undefined
      return Promise.resolve(hit ?? { rows: [], rowCount: 0 })
    },
    connect: () => Promise.reject(new Error('route tests must not open a transaction connection')),
  }),
  closeDbClient: async () => {},
}))

import { createDocumentsRouter, type DocumentIntakeWorkflowLike } from '../../src/api/documents'
import { parseEnv } from '../../src/config/env'

const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const USER = '660e8400-e29b-41d4-a716-446655440009'
const DOC = '770e8400-e29b-41d4-a716-446655440003'

const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}

function sqlFor(needle: string): { sql: string; params: unknown[] } | undefined {
  return db.calls.find((call) => call.sql.includes(needle))
}

function workflowReturning(outcome: unknown): { fake: DocumentIntakeWorkflowLike; start: ReturnType<typeof vi.fn> } {
  const start = vi.fn().mockResolvedValue(outcome)
  const fake: DocumentIntakeWorkflowLike = { createRun: vi.fn().mockResolvedValue({ start }) }
  return { fake, start }
}

function router(intake?: DocumentIntakeWorkflowLike | null): Hono {
  return createDocumentsRouter({
    env: parseEnv({}),
    ...(intake ? { getIntakeWorkflow: () => intake } : {}),
  })
}

function uploadForm(name = 'bill.pdf', type = 'application/pdf'): FormData {
  const form = new FormData()
  form.set('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type }))
  return form
}

const SUCCESS = {
  status: 'success',
  result: { documentId: DOC, status: 'ready', kind: 'invoice', confidence: 0.9, chunkCount: 4, indexName: `tenant_${TENANT}` },
}

beforeEach(() => {
  vi.clearAllMocks()
  db.calls.length = 0
  db.results = {}
})

describe('identity gate', () => {
  it('refuses before touching the database', async () => {
    const res = await router().request('/api/documents', { headers: { 'x-tenant-id': TENANT } })
    expect(res.status).toBe(401)
    expect((await json<{ error: string }>(res)).error).toBe('unauthorized')
    expect(db.calls).toHaveLength(0)
  })
})

describe('POST /api/documents/upload', () => {
  it('runs the intake workflow with the bytes, identity, and a tenant request context', async () => {
    const { fake, start } = workflowReturning(SUCCESS)

    const res = await router(fake).request('/api/documents/upload', { method: 'POST', headers: AUTH, body: uploadForm() })

    expect(res.status).toBe(201)
    expect((await json<{ documentId?: string; status?: string; kind?: string }>(res))).toMatchObject({
      documentId: DOC,
      status: 'ready',
      kind: 'invoice',
    })
    const args = start.mock.calls[0]![0] as { inputData: Record<string, unknown>; requestContext: { get: (k: string) => unknown } }
    expect(args.inputData).toMatchObject({ tenantId: TENANT, ownerId: USER, source: 'upload', title: 'bill.pdf' })
    // base64 of the three PDF header bytes, so the parse step can rebuild them.
    expect(Buffer.from(String(args.inputData.dataBase64), 'base64')).toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46]))
    expect(args.requestContext.get('tenantId')).toBe(TENANT)
    expect(args.requestContext.get('userId')).toBe(USER)
  })

  it('answers 503 when no intake workflow is wired', async () => {
    const res = await router().request('/api/documents/upload', { method: 'POST', headers: AUTH, body: uploadForm() })
    expect(res.status).toBe(503)
    expect((await json<{ error?: string }>(res)).error).toBe('intake-not-wired')
  })

  it('refuses a JSON body: upload is multipart only', async () => {
    const res = await router().request('/api/documents/upload', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(415)
  })

  it('refuses an extension the parse step cannot turn into text', async () => {
    const { fake, start } = workflowReturning(SUCCESS)
    const res = await router(fake).request('/api/documents/upload', {
      method: 'POST',
      headers: AUTH,
      body: uploadForm('sheet.xlsx', 'application/vnd.ms-excel'),
    })
    expect(res.status).toBe(415)
    expect(start).not.toHaveBeenCalled()
  })

  it('surfaces a needs_review outcome with a 201 (a valid, gated result)', async () => {
    const { fake } = workflowReturning({
      status: 'success',
      result: { documentId: DOC, status: 'needs_review', kind: 'invoice', confidence: 0.4, chunkCount: 2, indexName: 'idx' },
    })
    const res = await router(fake).request('/api/documents/upload', { method: 'POST', headers: AUTH, body: uploadForm() })
    expect(res.status).toBe(201)
    expect((await json<{ status?: string }>(res)).status).toBe('needs_review')
  })

  it('reports a failed run as a 502 with the workflow error', async () => {
    const { fake } = workflowReturning({ status: 'failed', error: { message: 'model unavailable' } })
    const res = await router(fake).request('/api/documents/upload', { method: 'POST', headers: AUTH, body: uploadForm() })
    expect(res.status).toBe(502)
    expect((await json<{ error?: string; detail?: string }>(res))).toMatchObject({
      error: 'intake_failed',
      detail: 'model unavailable',
    })
  })
})

describe('GET /api/documents', () => {
  it('lists through the tenant visibility predicate', async () => {
    db.results['FROM documents d'] = { rows: [{ id: DOC, kind: 'invoice', title: 'Bill', status: 'ready' }], rowCount: 1 }

    const body = await json<{ documents: { id: string }[]; total: number }>(
      router().request('/api/documents?kind=invoice', { headers: AUTH }),
    )

    expect(body.total).toBe(1)
    const list = sqlFor('FROM documents d')
    expect(list?.sql).toContain('d.tenant_id = $1')
    expect(list?.params).toContain('invoice')
  })

  it('rejects an unknown kind filter', async () => {
    const res = await router().request('/api/documents?kind=receipt', { headers: AUTH })
    expect(res.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })
})

describe('GET /api/documents/:id', () => {
  it('returns a visible document', async () => {
    db.results['FROM documents d'] = { rows: [{ id: DOC, kind: 'invoice', title: 'Bill', status: 'ready' }], rowCount: 1 }
    const body = await json<{ document?: { id: string } }>(
      router().request(`/api/documents/${DOC}`, { headers: AUTH }),
    )
    expect(body.document?.id).toBe(DOC)
  })

  it('answers 404 for a document it cannot see', async () => {
    const res = await router().request(`/api/documents/${DOC}`, { headers: AUTH })
    expect(res.status).toBe(404)
  })

  it('rejects a malformed id with 400, before the database', async () => {
    const res = await router().request('/api/documents/not-a-uuid', { headers: AUTH })
    expect(res.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })
})

describe('POST /api/documents/:id/review', () => {
  it('moves a needs_review document to ready', async () => {
    db.results['UPDATE documents AS d SET status'] = { rows: [{ id: DOC, status: 'ready' }], rowCount: 1 }

    const res = await router().request(`/api/documents/${DOC}/review`, { method: 'POST', headers: AUTH })
    expect(res.status).toBe(200)
    expect((await json<{ status?: string }>(res)).status).toBe('ready')
    const update = sqlFor('UPDATE documents AS d SET status')
    expect(update?.sql).toContain("status = 'needs_review'")
    expect(update?.sql).toContain('d.tenant_id = $1')
    expect(update?.params).toContain(DOC)
  })

  it('answers 404 when the id is not a visible needs_review document', async () => {
    const res = await router().request(`/api/documents/${DOC}/review`, { method: 'POST', headers: AUTH })
    expect(res.status).toBe(404)
  })
})
