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

// The two marketing modules the review route calls when an asset flips to ready.
// Mocked at the module seam so no route test opens a transaction or touches the
// marketing-assets table; the assertions are on the calls the route makes.
const writes = vi.hoisted(() => ({ invalidateOpenStageDraft: vi.fn() }))
const assets = vi.hoisted(() => ({ listBundleIdsForDocument: vi.fn() }))

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

vi.mock('../../src/db/pending-writes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/pending-writes')>()),
  invalidateOpenStageDraft: writes.invalidateOpenStageDraft,
}))

vi.mock('../../src/db/marketing-assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/marketing-assets')>()),
  listBundleIdsForDocument: assets.listBundleIdsForDocument,
}))

import {
  createDocumentsRouter,
  type DocumentJobSnapshot,
  type DocumentQueueLike,
} from '../../src/api/documents'
import { parseEnv } from '../../src/config/env'

const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const USER = '660e8400-e29b-41d4-a716-446655440009'
const DOC = '770e8400-e29b-41d4-a716-446655440003'
const BUNDLE = 'a1000000-0000-4000-8000-000000000099'
const OTHER_BUNDLE = 'a2000000-0000-4000-8000-000000000099'
const DRAFT = 'b1000000-0000-4000-8000-000000000099'

const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}

function sqlFor(needle: string): { sql: string; params: unknown[] } | undefined {
  return db.calls.find((call) => call.sql.includes(needle))
}

function queueFake(statusResult: DocumentJobSnapshot | null = null): {
  fake: DocumentQueueLike
  enqueue: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
} {
  const enqueue = vi.fn().mockResolvedValue('job-42')
  const status = vi.fn().mockResolvedValue(statusResult)
  return { fake: { enqueue, status }, enqueue, status }
}

function router(queue?: DocumentQueueLike | null): Hono {
  return createDocumentsRouter({
    env: parseEnv({}),
    ...(queue !== undefined ? { queue } : {}),
  })
}

function uploadForm(name = 'bill.pdf', type = 'application/pdf'): FormData {
  const form = new FormData()
  form.set('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type }))
  return form
}

beforeEach(() => {
  vi.clearAllMocks()
  db.calls.length = 0
  db.results = {}
  writes.invalidateOpenStageDraft.mockReset()
  assets.listBundleIdsForDocument.mockReset()
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
  it('queues the intake job with the bytes and the resolved identity', async () => {
    const { fake, enqueue } = queueFake()

    const res = await router(fake).request('/api/documents/upload', { method: 'POST', headers: AUTH, body: uploadForm() })

    expect(res.status).toBe(202)
    expect((await json<{ jobId?: string; status?: string }>(res))).toMatchObject({
      jobId: 'job-42',
      status: 'queued',
    })
    const job = enqueue.mock.calls[0]![0] as Record<string, unknown>
    expect(job).toMatchObject({ tenantId: TENANT, userId: USER, fileName: 'bill.pdf', source: 'upload' })
    // base64 of the three PDF header bytes, so the parse step can rebuild them.
    expect(Buffer.from(String(job.fileData), 'base64')).toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46]))
  })

  it('answers 503 when no queue is wired', async () => {
    const res = await router(null).request('/api/documents/upload', { method: 'POST', headers: AUTH, body: uploadForm() })
    expect(res.status).toBe(503)
    expect((await json<{ error?: string }>(res)).error).toBe('queue-not-wired')
  })

  it('refuses a JSON body: upload is multipart only', async () => {
    const res = await router(null).request('/api/documents/upload', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(res.status).toBe(415)
  })

  it('refuses an extension the parse step cannot turn into text', async () => {
    const { fake, enqueue } = queueFake()
    const res = await router(fake).request('/api/documents/upload', {
      method: 'POST',
      headers: AUTH,
      body: uploadForm('sheet.xlsx', 'application/vnd.ms-excel'),
    })
    expect(res.status).toBe(415)
    expect(enqueue).not.toHaveBeenCalled()
  })
})

describe('GET /api/documents/status/:jobId', () => {
  it('returns the queued job snapshot', async () => {
    const { fake } = queueFake({ id: 'job-42', state: 'active', progress: 40 })
    const body = await json<{ id?: string; state?: string; progress?: number }>(
      router(fake).request('/api/documents/status/job-42', { headers: AUTH }),
    )
    expect(body).toMatchObject({ id: 'job-42', state: 'active', progress: 40 })
  })

  it('answers 404 for a job the queue does not know', async () => {
    const { fake } = queueFake(null)
    const res = await router(fake).request('/api/documents/status/nope', { headers: AUTH })
    expect(res.status).toBe(404)
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
    expect((await json<{ detail?: string }>(res)).detail).toContain('marketing_asset')
    expect(db.calls).toHaveLength(0)
  })

  it('admits marketing_asset and asks the data layer for exactly that kind', async () => {
    db.results['FROM documents d'] = { rows: [], rowCount: 0 }
    const res = await router().request('/api/documents?kind=marketing_asset', { headers: AUTH })
    expect(res.status).toBe(200)
    const list = sqlFor('FROM documents d')
    expect(list?.sql).toContain('d.kind = $')
    expect(list?.params).toContain('marketing_asset')
  })

  it('still refuses a kind that is not one of the four', async () => {
    const res = await router().request('/api/documents?kind=purchase_order', { headers: AUTH })
    expect(res.status).toBe(400)
    expect((await json<{ detail?: string }>(res)).detail).toContain('marketing_asset')
  })

  it('returns 400 when min_field_confidence is not a number', async () => {
    const res = await router().request('/api/documents?min_field_confidence=abc', { headers: AUTH })
    expect(res.status).toBe(400)
    const body = await json<{ error?: string; detail?: string }>(res)
    expect(body.error).toBe('invalid_query')
    expect(body.detail).toContain('min_field_confidence')
    expect(db.calls).toHaveLength(0)
  })

  it('passes the min_field_confidence filter to listDocuments as a NOT EXISTS clause', async () => {
    db.results['FROM documents d'] = { rows: [], rowCount: 0 }
    const res = await router().request('/api/documents?min_field_confidence=0.7', { headers: AUTH })
    expect(res.status).toBe(200)
    const list = sqlFor('FROM documents d')
    expect(list).toBeDefined()
    expect(list!.sql).toContain('NOT EXISTS')
    expect(list!.sql).toContain('jsonb_each')
    expect(list!.params).toContain(0.7)
  })

  it('returns all documents when min_field_confidence is not provided', async () => {
    db.results['FROM documents d'] = {
      rows: [{ id: DOC, kind: 'invoice', title: 'Bill', status: 'ready' }],
      rowCount: 1,
    }
    const body = await json<{ documents: unknown[]; total: number }>(
      router().request('/api/documents', { headers: AUTH }),
    )
    expect(body.total).toBe(1)
    const list = sqlFor('FROM documents d')
    expect(list!.sql).not.toContain('NOT EXISTS')
    expect(list!.sql).not.toContain('jsonb_each')
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

  // A flip from `needs_review` to `ready` changes whether a bundle carrying this
  // picture can be staged at all, so an approval waiting on such a bundle is now
  // about a proposal that does not exist. An invoice or contract document attaches
  // to no bundle, so the name list is empty for those kinds and no write follows.
  it('invalidates every bundle a reviewed asset belongs to, and reports how many', async () => {
    db.results['UPDATE documents AS d SET status'] = {
      rows: [{ id: DOC, status: 'ready', kind: 'marketing_asset' }],
      rowCount: 1,
    }
    assets.listBundleIdsForDocument.mockResolvedValue([BUNDLE, OTHER_BUNDLE])
    writes.invalidateOpenStageDraft.mockResolvedValueOnce(DRAFT).mockResolvedValueOnce(null)

    const res = await router().request(`/api/documents/${DOC}/review`, { method: 'POST', headers: AUTH })

    expect(await json<{ status?: string; invalidatedBundles?: number }>(res)).toMatchObject({
      status: 'ready',
      invalidatedBundles: 1,
    })
    expect(assets.listBundleIdsForDocument).toHaveBeenCalledWith(TENANT, DOC)
    expect(writes.invalidateOpenStageDraft.mock.calls.map((c: unknown[]) => c[1])).toEqual([BUNDLE, OTHER_BUNDLE])
    expect(writes.invalidateOpenStageDraft.mock.calls[0]![2]).toBe('assets_changed_after_staging')
  })

  it('never reaches the marketing lane when an invoice is reviewed', async () => {
    db.results['UPDATE documents AS d SET status'] = {
      rows: [{ id: DOC, status: 'ready', kind: 'invoice' }],
      rowCount: 1,
    }
    const res = await router().request(`/api/documents/${DOC}/review`, { method: 'POST', headers: AUTH })
    expect((await json<{ invalidatedBundles?: number }>(res)).invalidatedBundles).toBe(0)
    expect(assets.listBundleIdsForDocument).not.toHaveBeenCalled()
  })

  it('reports zero when the asset belongs to no bundle', async () => {
    db.results['UPDATE documents AS d SET status'] = {
      rows: [{ id: DOC, status: 'ready', kind: 'marketing_asset' }],
      rowCount: 1,
    }
    assets.listBundleIdsForDocument.mockResolvedValue([])
    const res = await router().request(`/api/documents/${DOC}/review`, { method: 'POST', headers: AUTH })
    expect((await json<{ invalidatedBundles?: number }>(res)).invalidatedBundles).toBe(0)
    expect(writes.invalidateOpenStageDraft).not.toHaveBeenCalled()
  })
})
