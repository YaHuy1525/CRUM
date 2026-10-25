// src/api/knowledge.ts
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { RequestContext } from '@mastra/core/request-context'
import type { CrumEnv } from '../config/env'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import { getDbClient } from '../db/client'

/**
 * Knowledge manager REST routes. §6.3, §10.2.
 *
 * POST   /api/knowledge/upload                — accept text/markdown/html, then run `knowledge-ingest`
 * GET    /api/knowledge/documents             — list documents for the tenant
 * GET    /api/knowledge/documents/:id         — one document with its status
 * DELETE /api/knowledge/documents/:id         — retire a document
 * POST   /api/knowledge/documents/:id/reingest
 *
 * The upload route used to insert a row, flip `status` to `'processing'` and
 * return 202 without ever starting the workflow — so every upload sat in
 * `'processing'` forever and nothing was ever searchable. It now starts
 * `knowledge-ingest` and reports what actually happened.
 *
 * Ingestion is awaited inside the request. A detached `startAsync()` would answer
 * faster, but nothing in this build moves the row out of `'processing'` when a
 * background run finishes (the workflow has no terminal step, and a run survives
 * only as long as the process does), so a 202 would be a promise the server
 * cannot keep. The cost is stated in §10.2: a large document can outlive the
 * server timeout while the workflow keeps running server-side, so
 * `CRUM_API_PORT`'s `server.timeout` and `MASTRA_REQUEST_TIMEOUT_SECONDS` have to
 * agree with each other.
 */

/** The `knowledge-ingest` input, mirroring the workflow's own inputSchema. */
interface IngestInput {
  documentId: string
  tenantId: string
  content: string
  contentType: 'text' | 'markdown' | 'html'
  documentTitle: string
}

/**
 * The shapes `run.start()` can come back with (`WorkflowResult` in
 * @mastra/core/workflows: success | failed | tripwire | suspended | paused).
 * Only the first two are reachable for `knowledge-ingest` — the workflow has no
 * suspend step — but the route handles the rest as a failure rather than
 * assuming they cannot happen. Each member keeps its own literal status so the
 * union still narrows; a plain `{ status: string }` catch-all would widen it
 * back and make `result` / `error` unreachable.
 */
type IngestOutcome =
  | { status: 'success'; result?: { chunkCount: number; indexName: string } }
  | { status: 'failed'; error?: { message?: string } }
  | { status: 'tripwire' | 'suspended' | 'paused' }

/**
 * Structural view of the registered workflow. Taken from the Mastra instance
 * rather than importing `ingestWorkflow` directly, because a run started from a
 * workflow that is not registered on the instance has no storage, so its step
 * results are not persisted and the run cannot be resumed or traced.
 */
export interface IngestWorkflowLike {
  createRun(): Promise<{
    start(args: { inputData: IngestInput; requestContext?: RequestContext }): Promise<IngestOutcome>
  }>
}

export interface KnowledgeRouterDeps {
  env: CrumEnv
  /** Null when the instance is not built yet, which is answered as a real error. */
  getIngestWorkflow?: () => IngestWorkflowLike | null
}

const UploadSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  contentType: z.enum(['text', 'markdown', 'html']).default('text'),
})

/** Extensions the parse step can actually turn into text. §6.3.2 — there is no PDF or DOCX path. */
function contentTypeFromName(name: string): 'text' | 'markdown' | 'html' | null {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'txt' || ext === 'csv' || ext === 'json' || ext === '') return 'text'
  return null
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function createKnowledgeRouter(deps: KnowledgeRouterDeps): Hono {
  const { env } = deps
  const app = new Hono().basePath('/api/knowledge')

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

  app.post('/upload', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const { tenantId, userId } = gate.identity

    // Two accepted shapes: the JSON body the console posts, and a multipart form
    // with a `file` part (§10.2). Both end up as {title, content, contentType}.
    const form = c.req.header('content-type')?.includes('multipart/form-data')
      ? await c.req.parseBody()
      : null

    let parsed: z.infer<typeof UploadSchema>
    if (form) {
      const file = form.file
      if (!(file instanceof File)) {
        return c.json({ error: 'multipart upload requires a `file` part' }, 400)
      }
      const contentType = contentTypeFromName(file.name)
      if (!contentType) {
        // Stated rather than guessed at: handing a PDF to the text path would
        // embed its raw bytes as nonsense chunks that the retriever then cites.
        return c.json(
          { error: 'unsupported_file_type', detail: 'Only .txt, .md, .html and .json are parsed. Convert PDF/DOCX to text before upload.' },
          415,
        )
      }
      parsed = {
        title: typeof form.title === 'string' && form.title.trim() ? form.title.trim() : file.name,
        content: await file.text(),
        contentType,
      }
    } else {
      const body = UploadSchema.safeParse(await c.req.json().catch(() => null))
      if (!body.success) {
        return c.json({ error: 'title and content are required', detail: body.error.issues.map((i) => i.message) }, 400)
      }
      parsed = body.data
    }

    const db = getDbClient()

    // Dedup on content, per tenant. §5.1.
    const contentHash = await sha256Hex(parsed.content)

    // `ON CONFLICT DO NOTHING` instead of a SELECT-then-INSERT: `uq_knowledge_document_hash`
    // is a real constraint, so the two-statement version raced and answered 500.
    const inserted = await db.query<{ id: string; status: string }>(
      `INSERT INTO knowledge_documents (tenant_id, title, file_type, content_hash, byte_size, metadata, status, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7)
       ON CONFLICT (tenant_id, content_hash) DO NOTHING
       RETURNING id, status`,
      [
        tenantId,
        parsed.title,
        parsed.contentType,
        contentHash,
        // Bytes, not characters: the column is named byte_size and a multi-byte
        // title or body made the old `content.length` wrong by design.
        new TextEncoder().encode(parsed.content).length,
        JSON.stringify({ contentType: parsed.contentType, uploadedBy: userId }),
        userId,
      ],
    )

    const row = inserted.rows[0]
    if (!row) {
      const existing = await db.query<{ id: string; status: string; title: string }>(
        `SELECT id, status, title FROM knowledge_documents WHERE tenant_id = $1 AND content_hash = $2`,
        [tenantId, contentHash],
      )
      const hit = existing.rows[0]
      // Re-ingesting identical content would re-embed the same chunks under the
      // same ids, so a duplicate is a no-op that reports the document you already have.
      return c.json({
        documentId: hit?.id ?? null,
        title: hit?.title,
        status: hit?.status ?? 'unknown',
        deduplicated: true,
      })
    }

    const workflow = deps.getIngestWorkflow?.() ?? null
    if (!workflow) {
      // Say so, and leave the row visibly failed. The old code marked a document
      // 'processing' that no worker would ever pick up.
      await markFailed(db, row.id, 'ingest-not-wired')
      return c.json(
        { error: 'ingest-not-wired', detail: 'This router was created without getIngestWorkflow, so the document is stored but not indexed.', documentId: row.id },
        503,
      )
    }

    // `tenantVectorStoreResolver` reads `tenantId` out of the request context and
    // refuses to build a store without it, so starting the run without one fails
    // at the ingest step — after the embeddings have already been paid for.
    const requestContext = new RequestContext()
    requestContext.set('tenantId', tenantId)
    requestContext.set('userId', userId)

    let outcome: IngestOutcome
    try {
      const run = await workflow.createRun()
      outcome = await run.start({
        inputData: {
          documentId: row.id,
          tenantId,
          content: parsed.content,
          contentType: parsed.contentType,
          documentTitle: parsed.title,
        },
        requestContext,
      })
    } catch (err) {
      await markFailed(db, row.id, 'ingest-threw')
      throw err
    }

    if (outcome.status === 'success') {
      const updated = await db.query<{ id: string }>(
        `UPDATE knowledge_documents
           SET status = 'ready', updated_at = now(),
               metadata = metadata || jsonb_build_object('chunkCount', $3::int, 'indexName', $4)
         WHERE id = $1 AND tenant_id = $2
         RETURNING id`,
        [row.id, tenantId, outcome.result?.chunkCount ?? 0, outcome.result?.indexName ?? ''],
      )
      if (!updated.rows[0]) {
        // The row was removed between the insert and here (a delete racing this
        // upload). The chunks are indexed under a document id that no longer
        // exists, which the next re-index sweep will drop.
        return c.json({ error: 'document_vanished', documentId: row.id }, 410)
      }
      return c.json({
        documentId: row.id,
        status: 'ready',
        chunk_count: outcome.result?.chunkCount ?? null,
        index_name: outcome.result?.indexName ?? null,
      }, 201)
    }

    await markFailed(db, row.id, `ingest-${outcome.status}`)
    return c.json(
      {
        error: 'ingest_failed',
        documentId: row.id,
        status: outcome.status,
        detail: outcome.status === 'failed' ? outcome.error?.message : undefined,
      },
      502,
    )
  })

  app.get('/documents', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const db = getDbClient()
    const result = await db.query<Record<string, unknown>>(
      `SELECT id, title, file_type, content_hash, byte_size, status, owner_id, created_at, updated_at
         FROM knowledge_documents
        WHERE tenant_id = $1
        ORDER BY updated_at DESC
        LIMIT 100`,
      [gate.identity.tenantId],
    )

    return c.json({ documents: result.rows, total: result.rows.length })
  })

  app.get('/documents/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const db = getDbClient()
    const result = await db.query<Record<string, unknown>>(
      `SELECT id, title, file_type, content_hash, byte_size, metadata, status, owner_id, created_at, updated_at
         FROM knowledge_documents
        WHERE id = $1 AND tenant_id = $2`,
      [c.req.param('id'), gate.identity.tenantId],
    )

    const doc = result.rows[0]
    if (!doc) return c.json({ error: 'not_found' }, 404)
    return c.json({ document: doc })
  })

  /**
   * Retire a document. `knowledge_documents.status` has no `'deleted'` value (the
   * CHECK allows only pending/processing/ready/failed), so this is a `DELETE` of
   * the row rather than a status change that would relabel a healthy index as a
   * failure. The vector chunks stay until a re-index sweep removes them — the same
   * gap the previous soft-delete had, without the misleading status.
   */
  app.delete('/documents/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const db = getDbClient()
    const result = await db.query<{ id: string }>(
      `DELETE FROM knowledge_documents WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [c.req.param('id'), gate.identity.tenantId],
    )
    if (!result.rows[0]) return c.json({ error: 'not_found' }, 404)

    return c.json({ deleted: true, documentId: result.rows[0].id })
  })

  /**
   * Re-ingest is not implementable against the current schema: `knowledge_documents`
   * stores the content *hash* and never the content, so there is no source text to
   * re-chunk. It used to set `status = 'processing'` and answer 202, which produced
   * a document that looked like it was being rebuilt and was in fact untouched.
   * Reporting that as the 409 it is, and asking for a re-upload, is the honest
   * answer until a content column exists.
   */
  app.post('/documents/:id/reingest', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const db = getDbClient()
    const result = await db.query<{ id: string }>(
      `SELECT id FROM knowledge_documents WHERE id = $1 AND tenant_id = $2`,
      [c.req.param('id'), gate.identity.tenantId],
    )
    if (!result.rows[0]) return c.json({ error: 'not_found' }, 404)

    return c.json(
      {
        error: 'reingest_unsupported',
        detail: 'The source text is not stored (only its hash), so a document can only be re-indexed by uploading it again.',
        documentId: result.rows[0].id,
      },
      409,
    )
  })

  return app
}

async function markFailed(db: ReturnType<typeof getDbClient>, id: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE knowledge_documents
       SET status = 'failed', updated_at = now(),
           metadata = metadata || jsonb_build_object('failure', $2)
     WHERE id = $1`,
    [id, reason],
  )
}
