import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { RequestContext } from '@mastra/core/request-context'
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
import { MAX_DOCUMENT_BYTES } from '../mastra/workflows/document-intake'

interface IntakeInput {
  tenantId: string
  ownerId: string
  title: string
  mime: string
  source: 'upload' | 'email'
  sourceRef: string | null
  dataBase64: string
}

interface IntakeResult {
  documentId: string
  status: 'ready' | 'needs_review' | 'failed'
  kind: 'invoice' | 'contract' | 'other'
  confidence: number | null
  chunkCount: number
  indexName: string
}

type IntakeOutcome =
  | { status: 'success'; result?: IntakeResult }
  | { status: 'failed'; error?: { message?: string } }
  | { status: 'tripwire' | 'suspended' | 'paused' }

export interface DocumentIntakeWorkflowLike {
  createRun(): Promise<{
    start(args: {
      inputData: IntakeInput
      requestContext?: RequestContext
    }): Promise<IntakeOutcome>
  }>
}

export interface DocumentsRouterDeps {
  env: CrumEnv
  getIntakeWorkflow?: () => DocumentIntakeWorkflowLike | null
}

const IdSchema = z.string().uuid()

const ACCEPTED_EXT = new Set(['pdf', 'docx', 'txt', 'md', 'markdown', 'html', 'htm', 'csv', 'json'])

function extensionOf(name: string): string {
  return (name.toLowerCase().split('.').pop() ?? '').trim()
}

export function createDocumentsRouter(deps: DocumentsRouterDeps): Hono {
  const { env } = deps
  const app = new Hono().basePath('/api/documents')

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
    const { tenantId, userId, userRole } = gate.identity

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

    const workflow = deps.getIntakeWorkflow?.() ?? null
    if (!workflow) {
      return c.json(
        {
          error: 'intake-not-wired',
          detail: 'This router was created without getIntakeWorkflow, so the document cannot be processed.',
        },
        503,
      )
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const dataBase64 = Buffer.from(bytes).toString('base64')
    const title =
      typeof form.title === 'string' && form.title.trim() ? form.title.trim() : file.name

    const requestContext = new RequestContext()
    requestContext.set('tenantId', tenantId)
    requestContext.set('userId', userId)
    requestContext.set('tenantContext', { tenantId, userId, userRole })

    let outcome: IntakeOutcome
    try {
      const run = await workflow.createRun()
      outcome = await run.start({
        inputData: {
          tenantId,
          ownerId: userId,
          title,
          mime: file.type || '',
          source: 'upload',
          sourceRef: null,
          dataBase64,
        },
        requestContext,
      })
    } catch (err) {
      return c.json(
        { error: 'intake_threw', detail: err instanceof Error ? err.message : String(err) },
        502,
      )
    }

    if (outcome.status === 'success' && outcome.result) {
      return c.json(
        {
          documentId: outcome.result.documentId,
          status: outcome.result.status,
          kind: outcome.result.kind,
          confidence: outcome.result.confidence,
          chunkCount: outcome.result.chunkCount,
          indexName: outcome.result.indexName,
        },
        201,
      )
    }

    return c.json(
      {
        error: 'intake_failed',
        status: outcome.status,
        detail: outcome.status === 'failed' ? outcome.error?.message : undefined,
      },
      502,
    )
  })

  app.get('/', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const kind = c.req.query('kind')
    if (kind && !['invoice', 'contract', 'other'].includes(kind)) {
      return c.json({ error: 'invalid_query', detail: 'kind must be invoice, contract or other' }, 400)
    }
    const status = c.req.query('status')
    if (status && !['ready', 'needs_review'].includes(status)) {
      return c.json({ error: 'invalid_query', detail: 'status must be ready or needs_review' }, 400)
    }
    const customerId = c.req.query('customerId')
    if (customerId && !IdSchema.safeParse(customerId).success) {
      return c.json({ error: 'invalid_query', detail: 'customerId must be a uuid' }, 400)
    }

    const documents = await listDocuments(
      gate.identity,
      {
        kind: kind || undefined,
        status: status || undefined,
        customerId: customerId || undefined,
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
    return c.json({ documentId: updated.id, status: updated.status })
  })

  return app
}
