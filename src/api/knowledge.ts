import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { RequestContext } from '@mastra/core/request-context'
import type { CrumEnv } from '../config/env'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import { getDbClient } from '../db/client'


interface IngestInput {
  documentId: string
  tenantId: string
  content: string
  contentType: 'text' | 'markdown' | 'html'
  documentTitle: string
}

type IngestOutcome =
  | { status: 'success'; result?: { chunkCount: number; indexName: string } }
  | { status: 'failed'; error?: { message?: string } }
  | { status: 'tripwire' | 'suspended' | 'paused' }

export interface IngestWorkflowLike {
  createRun(): Promise<{
    start(args: { inputData: IngestInput; requestContext?: RequestContext }): Promise<IngestOutcome>
  }>
}

export interface KnowledgeRouterDeps {
  env: CrumEnv
  getIngestWorkflow?: () => IngestWorkflowLike | null
}

const UploadSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  contentType: z.enum(['text', 'markdown', 'html']).default('text'),
})

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

    const contentHash = await sha256Hex(parsed.content)

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
      return c.json({
        documentId: hit?.id ?? null,
        title: hit?.title,
        status: hit?.status ?? 'unknown',
        deduplicated: true,
      })
    }

    const workflow = deps.getIngestWorkflow?.() ?? null
    if (!workflow) {
      await markFailed(db, row.id, 'ingest-not-wired')
      return c.json(
        { error: 'ingest-not-wired', detail: 'This router was created without getIngestWorkflow, so the document is stored but not indexed.', documentId: row.id },
        503,
      )
    }

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
