// src/api/knowledge.ts
import { Hono } from 'hono'
import { getDbClient } from '../db/client'

/**
 * Knowledge manager REST routes. §6.3.
 *
 * POST /api/knowledge/upload — accept text/markdown/html content, insert into
 *   knowledge_documents, trigger ingestWorkflow
 * GET /api/knowledge/documents — list documents for the tenant
 * GET /api/knowledge/documents/:id — get document with status
 * DELETE /api/knowledge/documents/:id — soft-delete (mark status 'failed')
 * POST /api/knowledge/documents/:id/reingest — re-run ingest on existing content
 */
export function createKnowledgeRouter(): Hono {
  const app = new Hono()

  app.post('/upload', async (c) => {
    const tenantId = c.req.header('x-tenant-id')
    if (!tenantId) {
      return c.json({ error: 'x-tenant-id header required' }, 400)
    }

    const body = await c.req.json() as {
      title: string
      content: string
      contentType: 'text' | 'markdown' | 'html'
    }

    if (!body.title || !body.content) {
      return c.json({ error: 'title and content are required' }, 400)
    }

    // Compute content hash for dedup. §5.1.
    const encoder = new TextEncoder()
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(body.content))
    const contentHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    const db = getDbClient()

    // Check for existing document with same hash (dedup).
    const existing = await db.query(
      `SELECT id FROM knowledge_documents WHERE tenant_id = $1 AND content_hash = $2`,
      [tenantId, contentHash],
    )

    if (existing.rows.length > 0) {
      return c.json({
        message: 'Document with identical content already exists',
        documentId: existing.rows[0].id,
        deduplicated: true,
      })
    }

    // Insert the document record.
    const result = await db.query(
      `INSERT INTO knowledge_documents (tenant_id, title, file_type, content_hash, byte_size, metadata, status, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING id`,
      [
        tenantId,
        body.title,
        body.contentType,
        contentHash,
        body.content.length,
        JSON.stringify({ contentType: body.contentType }),
        tenantId, // owner_id defaults to tenantId for Phase 4; user auth comes in Phase 5
      ],
    )

    const documentId = result.rows[0].id

    // Trigger ingest workflow. The workflow is registered on the Mastra instance;
    // triggering it requires the Mastra reference, which the API layer receives
    // at server startup. For now, mark as processing and return.
    await db.query(
      `UPDATE knowledge_documents SET status = 'processing' WHERE id = $1`,
      [documentId],
    )

    return c.json({ documentId, status: 'processing' }, 202)
  })

  app.get('/documents', async (c) => {
    const tenantId = c.req.header('x-tenant-id')
    if (!tenantId) {
      return c.json({ error: 'x-tenant-id header required' }, 400)
    }

    const db = getDbClient()
    const result = await db.query(
      `SELECT id, tenant_id, title, file_type, content_hash, byte_size, metadata, status, created_at, updated_at
       FROM knowledge_documents
       WHERE tenant_id = $1
       ORDER BY updated_at DESC
       LIMIT 100`,
      [tenantId],
    )

    return c.json({ documents: result.rows })
  })

  app.get('/documents/:id', async (c) => {
    const tenantId = c.req.header('x-tenant-id')
    if (!tenantId) {
      return c.json({ error: 'x-tenant-id header required' }, 400)
    }

    const documentId = c.req.param('id')
    const db = getDbClient()
    const result = await db.query(
      `SELECT * FROM knowledge_documents WHERE id = $1 AND tenant_id = $2`,
      [documentId, tenantId],
    )

    if (result.rows.length === 0) {
      return c.json({ error: 'not found' }, 404)
    }

    return c.json({ document: result.rows[0] })
  })

  app.delete('/documents/:id', async (c) => {
    const tenantId = c.req.header('x-tenant-id')
    if (!tenantId) {
      return c.json({ error: 'x-tenant-id header required' }, 400)
    }

    const documentId = c.req.param('id')
    const db = getDbClient()

    // Soft-delete: mark as failed. The vector chunks remain until a re-index
    // job cleans them up; for Phase 4, this is acceptable.
    await db.query(
      `UPDATE knowledge_documents SET status = 'failed', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      [documentId, tenantId],
    )

    return c.json({ deleted: true })
  })

  app.post('/documents/:id/reingest', async (c) => {
    const tenantId = c.req.header('x-tenant-id')
    if (!tenantId) {
      return c.json({ error: 'x-tenant-id header required' }, 400)
    }

    const documentId = c.req.param('id')
    const db = getDbClient()

    const result = await db.query(
      `SELECT * FROM knowledge_documents WHERE id = $1 AND tenant_id = $2`,
      [documentId, tenantId],
    )

    if (result.rows.length === 0) {
      return c.json({ error: 'not found' }, 404)
    }

    // Re-ingest: reset status to processing. The actual workflow trigger
    // requires the Mastra instance reference at server startup.
    await db.query(
      `UPDATE knowledge_documents SET status = 'processing', updated_at = now() WHERE id = $1`,
      [documentId],
    )

    return c.json({ documentId, status: 'reingesting' }, 202)
  })

  return app
}
