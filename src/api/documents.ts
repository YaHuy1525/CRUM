import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { CrumEnv } from '../config/env'
import type { TenantRequestContext } from '../mastra/tenant-context'
import { IdentityError, resolveIdentity } from '../mastra/identity'
import {
  listDocuments,
  getDocument,
  getInvoice,
  getContract,
  reviewDocument,
} from '../db/documents'
import { invalidateOpenStageDraft } from '../db/pending-writes'
import { listBundleIdsForDocument } from '../db/marketing-assets'
import { setAuditContext } from '../db/audit-context'
import { MAX_DOCUMENT_BYTES } from '../mastra/workflows/document-intake'
import type { DocumentJobData } from '../queue/document-queue'
import { getDbClient } from '../db/client'
import type { PoolClient } from 'pg'

/** The slice of the job queue the upload plane needs, injected so routes stay testable. */
export interface DocumentJobSnapshot {
  id?: string | null
  state: string
  progress?: unknown
  data?: DocumentJobData
  result?: unknown
  failedReason?: string
  timestamp?: number
  processedOn?: number
  finishedOn?: number
}

export interface DocumentQueueLike {
  enqueue(data: DocumentJobData): Promise<string>
  status(jobId: string): Promise<DocumentJobSnapshot | null>
}

export interface DocumentsRouterDeps {
  env: CrumEnv
  /**
   * `undefined` loads the BullMQ-backed queue on the first request that needs it,
   * `null` means this plane has no queue and refuses uploads with 503, and a fake
   * is what the route tests pass. The queue module is imported lazily because it
   * opens a Redis connection as soon as it is loaded.
   */
  queue?: DocumentQueueLike | null
}

let defaultQueue: Promise<DocumentQueueLike> | null = null

function loadDefaultQueue(): Promise<DocumentQueueLike> {
  if (defaultQueue === null) {
    defaultQueue = import('../queue/document-queue').then((mod) => ({
      enqueue: mod.queueDocumentProcessing,
      status: mod.getJobStatus,
    }))
  }
  return defaultQueue
}

const IdSchema = z.string().uuid()

const ACCEPTED_EXT = new Set(['pdf', 'docx', 'txt', 'md', 'markdown', 'html', 'htm', 'csv', 'json'])

function extensionOf(name: string): string {
  return (name.toLowerCase().split('.').pop() ?? '').trim()
}

export function createDocumentsRouter(deps: DocumentsRouterDeps): Hono {
  const { env, queue } = deps
  const app = new Hono().basePath('/api/documents')

  async function resolveQueue(): Promise<DocumentQueueLike | null> {
    if (queue !== undefined) return queue
    return loadDefaultQueue()
  }

  const auth = async (
    c: Context,
  ): Promise<{ identity: TenantRequestContext } | { error: Response }> => {
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

    if (!c.req.header('content-type')?.includes('multipart/form-data')) {
      return c.json(
        { error: 'multipart_required', detail: 'Upload a file as multipart/form-data with a `file` part.' },
        415,
      )
    }

    const form = await c.req.parseBody()
    const file = form.file
    if (!(file instanceof File)) {
      return c.json({ error: 'multipart upload requires a `file` part' }, 400)
    }

    const ext = extensionOf(file.name)
    if (!ACCEPTED_EXT.has(ext)) {
      return c.json(
        {
          error: 'unsupported_file_type',
          detail: 'Upload a .pdf, .docx, .txt, .md, .html, .csv or .json file.',
        },
        415,
      )
    }

    if (file.size > MAX_DOCUMENT_BYTES) {
      return c.json(
        { error: 'file_too_large', detail: `Documents must be ${MAX_DOCUMENT_BYTES} bytes or smaller.` },
        413,
      )
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const dataBase64 = Buffer.from(bytes).toString('base64')
    const title =
      typeof form.title === 'string' && form.title.trim() ? form.title.trim() : file.name

    const queueRef = await resolveQueue()
    if (!queueRef) {
      return c.json(
        {
          error: 'queue-not-wired',
          detail: 'No document queue is attached to this plane, so intake cannot run.',
        },
        503,
      )
    }

    const fileId = `${tenantId}_${Date.now()}_${Math.random().toString(36).substring(7)}`

    try {
      const jobId = await queueRef.enqueue({
        tenantId,
        userId,
        fileId,
        fileName: title,
        fileData: dataBase64,
        mimeType: file.type || '',
        source: 'upload',
      })

      return c.json(
        {
          jobId,
          fileId,
          status: 'queued',
          message: 'Document queued for processing. Use GET /api/documents/status/:jobId to check progress.',
        },
        202,
      )
    } catch (err) {
      return c.json(
        { error: 'queue_failed', detail: err instanceof Error ? err.message : String(err) },
        500,
      )
    }
  })

  app.get('/status/:jobId', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const jobId = c.req.param('jobId')
    if (!jobId) {
      return c.json({ error: 'jobId_required' }, 400)
    }

    const queueRef = await resolveQueue()
    if (!queueRef) {
      return c.json(
        { error: 'queue-not-wired', detail: 'No document queue is attached to this plane.' },
        503,
      )
    }

    try {
      const status = await queueRef.status(jobId)
      if (!status) {
        return c.json({ error: 'job_not_found' }, 404)
      }

      return c.json(status)
    } catch (err) {
      return c.json(
        { error: 'status_check_failed', detail: err instanceof Error ? err.message : String(err) },
        500,
      )
    }
  })

  app.get('/', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const kind = c.req.query('kind')
    // Assets are admitted to a whitelist that already does the filtering, which is
    // the smallest change that makes a paid-for picture findable. An unfiltered
    // list still excludes them (`src/db/documents.ts:389`), so the owner's invoice
    // view does not fill up with PNGs: whoever wants renders has to say so. A new
    // browse-only byte route was refused, because an ungated thumbnail of a bundle
    // nobody has predicted for would undo the cognitive forcing gate (spec section
    // 10.2).
    if (kind && !['invoice', 'contract', 'other', 'marketing_asset'].includes(kind)) {
      return c.json(
        { error: 'invalid_query', detail: 'kind must be invoice, contract, other or marketing_asset' },
        400,
      )
    }
    const status = c.req.query('status')
    if (status && !['ready', 'needs_review'].includes(status)) {
      return c.json({ error: 'invalid_query', detail: 'status must be ready or needs_review' }, 400)
    }
    const customerId = c.req.query('customerId')
    if (customerId && !IdSchema.safeParse(customerId).success) {
      return c.json({ error: 'invalid_query', detail: 'customerId must be a uuid' }, 400)
    }
    const minFieldConfidenceRaw = c.req.query('min_field_confidence')
    let minFieldConfidence: number | undefined
    if (minFieldConfidenceRaw) {
      minFieldConfidence = parseFloat(minFieldConfidenceRaw)
      if (isNaN(minFieldConfidence)) {
        return c.json({ error: 'invalid_query', detail: 'min_field_confidence must be a number' }, 400)
      }
    }

    const documents = await listDocuments(
      gate.identity,
      {
        kind: kind || undefined,
        status: status || undefined,
        customerId: customerId || undefined,
        minFieldConfidence,
      },
    )
    return c.json({ documents, total: documents.length })
  })

  app.get('/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)

    const document = await getDocument(gate.identity, id.data)
    if (!document) return c.json({ error: 'not_found' }, 404)
    return c.json({ document })
  })

  app.get('/:id/invoice', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)

    const document = await getDocument(gate.identity, id.data)
    if (!document) return c.json({ error: 'not_found' }, 404)
    if (document.kind !== 'invoice') return c.json({ error: 'not_an_invoice' }, 409)

    const { header, lines } = await getInvoice(gate.identity, id.data)
    return c.json({ document, invoice: header, lines })
  })

  app.get('/:id/contract', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)

    const document = await getDocument(gate.identity, id.data)
    if (!document) return c.json({ error: 'not_found' }, 404)
    if (document.kind !== 'contract') return c.json({ error: 'not_a_contract' }, 409)

    const { header, terms } = await getContract(gate.identity, id.data)
    return c.json({ document, contract: header, terms })
  })

  app.post('/:id/review', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)

    const updated = await reviewDocument(gate.identity, id.data)
    if (!updated) return c.json({ error: 'not_found_or_not_pending' }, 404)

    // A flip from `needs_review` to `ready` changes whether a bundle carrying this
    // picture can be staged at all (`marketing.stage_bundle` refuses on exactly this
    // column, marketing-writes.ts:443-447), so an approval waiting on such a bundle
    // is now about a proposal that does not exist. In the route and not inside
    // `reviewDocument`: the data module would have to import `marketing-assets.ts`,
    // which imports `documents.ts`, and the cycle is a worse price than one route
    // that has to remember to call it. An invoice or contract document attaches to
    // no bundle, so the name list is empty for those kinds and no write follows.
    let invalidatedBundles = 0
    if (updated.kind === 'marketing_asset') {
      const bundleIds = await listBundleIdsForDocument(gate.identity.tenantId, updated.id)
      for (const bundleId of bundleIds) {
        const draftId = await invalidateOpenStageDraft(gate.identity.tenantId, bundleId, 'assets_changed_after_staging')
        if (draftId !== null) invalidatedBundles += 1
      }
    }
    return c.json({ documentId: updated.id, status: updated.status, invalidatedBundles })
  })

  app.get('/:id/audit', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)

    const docResult = await getDbClient().query<{ id: string }>(
      `SELECT id FROM documents WHERE id = $1 AND tenant_id = $2`,
      [id.data, gate.identity.tenantId],
    )

    if (docResult.rows.length === 0) {
      return c.json({ error: 'not_found' }, 404)
    }

    const result = await getDbClient().query<{
      document_id: string
      tenant_id: string
      table_name: string
      field_name: string
      action: string
      old_value: unknown
      new_value: unknown
      changed_by: string | null
      changed_at: string
      change_source: string
      reason: string | null
    }>(
      `SELECT document_id, tenant_id, table_name, field_name, action, old_value, new_value,
              changed_by, changed_at, change_source, reason
       FROM document_field_audit
       WHERE document_id = $1 AND tenant_id = $2
       ORDER BY changed_at DESC`,
      [id.data, gate.identity.tenantId],
    )

    return c.json({ audit: result.rows })
  })

  const ALLOWED_INVOICE_FIELDS = ['vendor_name', 'vendor_email', 'invoice_number', 'invoice_date', 'due_date', 'currency', 'subtotal', 'tax', 'total']
  const ALLOWED_CONTRACT_FIELDS = ['counterparty', 'counterparty_email', 'effective_date', 'expiry_date', 'term_months', 'contract_value', 'currency', 'auto_renewal', 'renewal_notice_days']

  interface CorrectionBody {
    value: unknown
    reason?: string
  }

  async function handleCorrection(
    c: Context,
    allowedFields: string[],
    tableName: 'invoices' | 'contracts',
    docKind: 'invoice' | 'contract',
  ) {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const docId = c.req.param('id')
    const field = c.req.param('field')
    const body = await c.req.json<CorrectionBody>()
    const identity = gate.identity

    if (!field || !allowedFields.includes(field)) {
      return c.json({ error: `Field not correctable: '${field}'` }, 400)
    }

    // Verify document exists and belongs to tenant
    const docResult = await getDbClient().query<{ id: string }>(
      `SELECT id FROM documents WHERE id = $1 AND tenant_id = $2 AND kind = $3`,
      [docId, identity.tenantId, docKind],
    )

    if (docResult.rows.length === 0) {
      return c.json({ error: 'Document not found' }, 404)
    }

    // Use a dedicated connection so set_config + UPDATE share the same session,
    // guaranteeing the audit trigger sees the correct changed_by / change_source.
    const client: PoolClient = await getDbClient().connect()
    try {
      await client.query('BEGIN')
      await setAuditContext(client, { userId: identity.userId, changeSource: 'manual_correction' })

      await client.query(
        `UPDATE ${tableName} SET ${field} = $1 WHERE document_id = $2`,
        [body.value, docId],
      )

      if (body.reason) {
        await client.query(
          `UPDATE document_field_audit SET reason = $1 WHERE document_id = $2 AND field_name = $3 AND changed_at = (SELECT MAX(changed_at) FROM document_field_audit WHERE document_id = $2 AND field_name = $3)`,
          [body.reason, docId, field],
        )
      }

      await client.query('COMMIT')
      return c.json({ success: true })
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  app.patch('/:id/invoices/:field', (c) =>
    handleCorrection(c, ALLOWED_INVOICE_FIELDS, 'invoices', 'invoice'),
  )

  app.patch('/:id/contracts/:field', (c) =>
    handleCorrection(c, ALLOWED_CONTRACT_FIELDS, 'contracts', 'contract'),
  )

  return app
}
