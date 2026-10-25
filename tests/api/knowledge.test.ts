// tests/api/knowledge.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

/**
 * The knowledge manager routes, exercised over real HTTP through the Hono app.
 *
 * What these tests exist to prove is the part the stub got wrong: the upload
 * route used to write a row, mark it `'processing'` and answer 202 without ever
 * starting `knowledge-ingest`, so nothing was indexed and nothing ever left that
 * status. Here the workflow call itself is asserted — its input, the request
 * context the vector store resolver demands, and what the row is set to when the
 * run comes back failed instead of succeeded.
 *
 * The pg singleton is mocked, so no DATABASE_URL and no Supabase. The SQL text is
 * asserted where the text *is* the contract (the dedup conflict target, the
 * tenant predicate on every by-id route); the statements themselves are pinned
 * against the schema in migrations/0002_crum_spine.sql.
 */
interface FakeResult {
  rows: unknown[]
  rowCount: number
}

const db = vi.hoisted((): { calls: { sql: string; params: unknown[] }[]; results: Record<string, FakeResult> } => ({
  calls: [],
  /** First substring match on the SQL wins; unmatched statements return no rows. */
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
  }),
  closeDbClient: async () => {},
}))

import { createKnowledgeRouter, type IngestWorkflowLike } from '../../src/api/knowledge'
import { parseEnv } from '../../src/config/env'

const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const USER = '660e8400-e29b-41d4-a716-446655440009'
const DOC = '770e8400-e29b-41d4-a716-446655440003'

/** dev-mode identity: all three headers, because `resolveIdentity` has no defaults. */
const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

/**
 * `Response.json()` is `unknown` under this tsconfig and `app.request()` is typed
 * as possibly-sync, so one helper absorbs both (same shape as the approvals suite).
 */
async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}

function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

interface UploadBody {
  documentId?: string
  status?: string
  title?: string
  deduplicated?: boolean
  chunk_count?: number | null
  index_name?: string | null
  error?: string
  detail?: string | string[]
  reason?: string
}

/** Statement the routes are expected to run, so a test can fail on a missing one. */
function sqlFor(needle: string): { sql: string; params: unknown[] } | undefined {
  return db.calls.find((call) => call.sql.includes(needle))
}

/** Records what `run.start()` was called with, and answers with `outcome`. */
function workflowReturning(outcome: unknown): { fake: IngestWorkflowLike; start: ReturnType<typeof vi.fn> } {
  const start = vi.fn().mockResolvedValue(outcome)
  // A mock rather than an async arrow: the router awaits `createRun()`, which
  // accepts a promise, and an async body with no await inside is a lint error.
  const fake: IngestWorkflowLike = { createRun: vi.fn().mockResolvedValue({ start }) }
  return { fake, start }
}

function router(ingest?: IngestWorkflowLike | null): Hono {
  return createKnowledgeRouter({
    env: parseEnv({}),
    ...(ingest ? { getIngestWorkflow: () => ingest } : {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  db.calls.length = 0
  db.results = {}
  // Default: the insert lands a fresh row, and the status update finds it.
  db.results['INSERT INTO knowledge_documents'] = { rows: [{ id: DOC, status: 'processing' }], rowCount: 1 }
  db.results["UPDATE knowledge_documents"] = { rows: [{ id: DOC }], rowCount: 1 }
})

describe('identity gate', () => {
  it('refuses a request without a complete identity, before touching the database', async () => {
    const res = await router().request('/api/knowledge/documents', { headers: { 'x-tenant-id': TENANT } })

    expect(res.status).toBe(401)
    expect((await json<UploadBody>(res)).error).toBe('unauthorized')
    expect(db.calls).toHaveLength(0)
  })
})

describe('POST /api/knowledge/upload', () => {
  it('stores the document with a tenant-scoped hash, the caller as owner, and real bytes', async () => {
    const { fake, start } = workflowReturning({ status: 'success', result: { chunkCount: 4, indexName: `tenant_${TENANT}` } })

    // 'héllo' is 5 characters and 6 UTF-8 bytes: the column is byte_size, and the
    // stub wrote content.length, so every multi-byte body under-reported its size.
    const res = await router(fake).request(
      '/api/knowledge/upload',
      postJson({ title: 'Notes', content: 'héllo', contentType: 'text' }),
    )

    expect(res.status).toBe(201)
    const insert = sqlFor('INSERT INTO knowledge_documents')
    expect(insert?.params[0]).toBe(TENANT)
    expect(insert?.params[4]).toBe(6)
    expect(insert?.params[6]).toBe(USER)
    expect(start).toHaveBeenCalledOnce()
  })

  it('starts knowledge-ingest with the stored id and a request context carrying tenantId', async () => {
    const { fake, start } = workflowReturning({ status: 'success', result: { chunkCount: 2, indexName: 'idx' } })

    await router(fake).request('/api/knowledge/upload', postJson({ title: 'Notes', content: 'body' }))

    const args = start.mock.calls[0]![0] as {
      inputData: Record<string, unknown>
      requestContext: { get: (k: string) => unknown }
    }
    expect(args.inputData).toMatchObject({ documentId: DOC, tenantId: TENANT, content: 'body', documentTitle: 'Notes' })
    // `tenantVectorStoreResolver` throws 'tenantId is required in request context'
    // without this, which would fail at the ingest step — after the embeddings.
    expect(args.requestContext.get('tenantId')).toBe(TENANT)
    expect(args.requestContext.get('userId')).toBe(USER)
  })

  it('marks the document ready with its chunk count when the run succeeds', async () => {
    const { fake } = workflowReturning({ status: 'success', result: { chunkCount: 7, indexName: 'tenant_idx' } })

    const body = await json<UploadBody>(
      router(fake).request('/api/knowledge/upload', postJson({ title: 'Notes', content: 'body' })),
    )

    expect(body).toMatchObject({ documentId: DOC, status: 'ready', chunk_count: 7, index_name: 'tenant_idx' })
    const update = sqlFor("SET status = 'ready'")
    expect(update?.params).toEqual([DOC, TENANT, 7, 'tenant_idx'])
    // the update is tenant-scoped even though the id was just minted by us
    expect(update?.sql).toContain('tenant_id = $2')
  })

  it('answers a duplicate with the document it already has, and does not re-index it', async () => {
    const { fake, start } = workflowReturning({ status: 'success', result: { chunkCount: 1, indexName: 'idx' } })
    // The INSERT's conflict target is the schema's own UNIQUE (tenant_id, content_hash).
    db.results['INSERT INTO knowledge_documents'] = { rows: [], rowCount: 0 }
    db.results['SELECT id, status, title FROM knowledge_documents'] = {
      rows: [{ id: DOC, status: 'ready', title: 'Notes' }],
      rowCount: 1,
    }

    const res = await router(fake).request('/api/knowledge/upload', postJson({ title: 'Notes', content: 'body' }))
    const body = await json<UploadBody>(res)

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ documentId: DOC, status: 'ready', deduplicated: true })
    // Re-embedding identical content would rewrite the same chunks for nothing.
    expect(start).not.toHaveBeenCalled()
    expect(sqlFor('ON CONFLICT (tenant_id, content_hash) DO NOTHING')).toBeDefined()
  })

  it('reports 503 and a failed row when no ingest workflow is wired', async () => {
    const res = await router().request('/api/knowledge/upload', postJson({ title: 'Notes', content: 'body' }))
    const body = await json<UploadBody>(res)

    expect(res.status).toBe(503)
    expect(body.error).toBe('ingest-not-wired')
    // Not left sitting in 'processing' for a worker that does not exist.
    const failed = sqlFor("SET status = 'failed'")
    expect(failed?.params).toEqual([DOC, 'ingest-not-wired'])
  })

  it('reports the failed run as a 502 with the workflow error, and records it', async () => {
    const { fake } = workflowReturning({ status: 'failed', error: { message: 'embedding quota exceeded' } })

    const res = await router(fake).request('/api/knowledge/upload', postJson({ title: 'Notes', content: 'body' }))
    const body = await json<UploadBody>(res)

    expect(res.status).toBe(502)
    expect(body).toMatchObject({ error: 'ingest_failed', status: 'failed', detail: 'embedding quota exceeded' })
    expect(sqlFor("SET status = 'failed'")?.params).toEqual([DOC, 'ingest-failed'])
  })

  it('treats a non-success run that is not a plain failure as a failure too', async () => {
    const { fake } = workflowReturning({ status: 'tripwire' })

    const res = await router(fake).request('/api/knowledge/upload', postJson({ title: 'Notes', content: 'body' }))

    expect(res.status).toBe(502)
    expect((await json<UploadBody>(res)).status).toBe('tripwire')
    expect(sqlFor("SET status = 'failed'")?.params[1]).toBe('ingest-tripwire')
  })

  it('marks the row failed if the run throws instead of returning', async () => {
    const start = vi.fn().mockRejectedValue(new Error('engine exploded'))
    const fake: IngestWorkflowLike = { createRun: vi.fn().mockResolvedValue({ start }) }

    // Hono turns the rethrow into a 500; the point is the row is not left in 'processing'.
    const res = await router(fake).request('/api/knowledge/upload', postJson({ title: 'Notes', content: 'body' }))

    expect(res.status).toBe(500)
    expect(sqlFor("SET status = 'failed'")?.params).toEqual([DOC, 'ingest-threw'])
  })

  it('answers 410 when the row it just indexed has been deleted underneath it', async () => {
    const { fake } = workflowReturning({ status: 'success', result: { chunkCount: 1, indexName: 'idx' } })
    db.results["UPDATE knowledge_documents"] = { rows: [], rowCount: 0 }

    const res = await router(fake).request('/api/knowledge/upload', postJson({ title: 'Notes', content: 'body' }))

    expect(res.status).toBe(410)
    expect((await json<UploadBody>(res)).error).toBe('document_vanished')
  })

  it('rejects a body without a title or content instead of storing an empty document', async () => {
    const res = await router().request('/api/knowledge/upload', postJson({ title: '' }))

    expect(res.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it('accepts a multipart file and derives the content type from its name', async () => {
    const { fake, start } = workflowReturning({ status: 'success', result: { chunkCount: 1, indexName: 'idx' } })
    const form = new FormData()
    form.set('file', new File(['# Heading\n\ntext'], 'playbook.md', { type: 'text/markdown' }))

    const res = await router(fake).request('/api/knowledge/upload', { method: 'POST', headers: AUTH, body: form })

    expect(res.status).toBe(201)
    expect(start.mock.calls[0]![0]).toMatchObject({
      inputData: { content: '# Heading\n\ntext', contentType: 'markdown', documentTitle: 'playbook.md' },
    })
  })

  it('refuses a file type the parse step cannot turn into text', async () => {
    const { fake, start } = workflowReturning({ status: 'success', result: { chunkCount: 1, indexName: 'idx' } })
    const form = new FormData()
    form.set('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'proposal.pdf'))

    const res = await router(fake).request('/api/knowledge/upload', { method: 'POST', headers: AUTH, body: form })

    expect(res.status).toBe(415)
    expect((await json<UploadBody>(res)).error).toBe('unsupported_file_type')
    // Handing the PDF to the text path would embed its bytes as nonsense chunks.
    expect(start).not.toHaveBeenCalled()
    expect(db.calls).toHaveLength(0)
  })
})

describe('GET /api/knowledge/documents', () => {
  it('lists only the caller tenant and never echoes tenant_id back', async () => {
    db.results['SELECT id, title, file_type'] = { rows: [{ id: DOC, title: 'Notes', status: 'ready' }], rowCount: 1 }

    const body = await json<{ documents: Record<string, unknown>[]; total: number }>(
      router().request('/api/knowledge/documents', { headers: AUTH }),
    )

    expect(body.total).toBe(1)
    expect(body.documents[0]!.tenant_id).toBeUndefined()
    const list = sqlFor('SELECT id, title, file_type')
    expect(list?.sql).toContain('WHERE tenant_id = $1')
    expect(list?.params).toEqual([TENANT])
  })
})

describe('GET /api/knowledge/documents/:id', () => {
  it('returns the document when it belongs to the caller', async () => {
    db.results['SELECT id, title, file_type, content_hash, byte_size, metadata'] = {
      rows: [{ id: DOC, title: 'Notes', status: 'ready' }],
      rowCount: 1,
    }

    const body = await json<{ document?: Record<string, unknown>; error?: string }>(
      router().request(`/api/knowledge/documents/${DOC}`, { headers: AUTH }),
    )

    expect(body.document?.id).toBe(DOC)
    // by id *and* by tenant, in one predicate: a uuid alone must not resolve another tenant's row
    expect(sqlFor('WHERE id = $1 AND tenant_id = $2')?.params).toEqual([DOC, TENANT])
  })

  it('answers 404 for a document it cannot see', async () => {
    const res = await router().request(`/api/knowledge/documents/${DOC}`, { headers: AUTH })

    expect(res.status).toBe(404)
    expect((await json<UploadBody>(res)).error).toBe('not_found')
  })
})

describe('DELETE /api/knowledge/documents/:id', () => {
  it('really deletes the row, because status has no deleted value', async () => {
    db.results['DELETE FROM knowledge_documents'] = { rows: [{ id: DOC }], rowCount: 1 }

    const body = await json<{ deleted?: boolean; documentId?: string }>(
      router().request(`/api/knowledge/documents/${DOC}`, { method: 'DELETE', headers: AUTH }),
    )

    expect(body).toMatchObject({ deleted: true, documentId: DOC })
    expect(sqlFor('DELETE FROM knowledge_documents')?.params).toEqual([DOC, TENANT])
    // 'deleted' is outside the CHECK constraint, so a status change would have failed.
    expect(sqlFor("SET status = 'deleted'")).toBeUndefined()
  })

  it('answers 404 when the delete matches nothing', async () => {
    const res = await router().request(`/api/knowledge/documents/${DOC}`, { method: 'DELETE', headers: AUTH })

    expect(res.status).toBe(404)
  })
})

describe('POST /api/knowledge/documents/:id/reingest', () => {
  it('refuses rather than pretending, because only the hash is stored', async () => {
    db.results['SELECT id FROM knowledge_documents'] = { rows: [{ id: DOC }], rowCount: 1 }

    const res = await router().request(`/api/knowledge/documents/${DOC}/reingest`, postJson({}))
    const body = await json<UploadBody>(res)

    expect(res.status).toBe(409)
    expect(body.error).toBe('reingest_unsupported')
    // The stub set 'processing' and answered 202 for a document nobody rebuilt.
    expect(sqlFor("SET status = 'processing'")).toBeUndefined()
  })

  it('answers 404 before refusing, so the 409 is not an existence oracle', async () => {
    const res = await router().request(`/api/knowledge/documents/${DOC}/reingest`, postJson({}))

    expect(res.status).toBe(404)
    expect((await json<UploadBody>(res)).error).toBe('not_found')
  })
})
