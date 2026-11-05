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
  type InvoiceRow,
  type InvoiceLineRow,
  type ContractRow,
  type ContractTermRow,
  type DocumentRow,
} from '../db/documents'
import { invalidateOpenStageDraft } from '../db/pending-writes'
import { listBundleIdsForDocument } from '../db/marketing-assets'
import { setAuditContext } from '../db/audit-context'
import { CONFIDENCE_THRESHOLD, MAX_DOCUMENT_BYTES } from '../mastra/workflows/document-intake'
import type { DocumentJobData } from '../queue/document-queue'
import { getDbClient } from '../db/client'
import { toIsoString } from '../db/timestamps'
import { docVisibility } from '../db/visibility'
import type { PoolClient } from 'pg'
import {
  listViolations,
  waiveViolation,
  replaceValidation,
  reviewQueue,
  reviewAnalytics,
  exportAuditRows,
  type AnalyticsWindow,
  type Q,
  type ReviewQueueItem,
  type ReviewQueueRow,
  type StoredViolation,
} from '../db/validation'
import { parseCursor } from '../db/cursor'
import { CHANGE_SOURCES } from '../db/audit-context'
import { buildAuditCsv, MAX_EXPORT_ROWS } from './audit-csv'
import { evaluate, buildBundle, localDay, RULESET_VERSION } from '../validation/index'
import { parseDate } from '../validation/values'
import { INVOICE_FIELDS, CONTRACT_FIELDS, isCorrectable } from '../validation/fields'
import type { DocumentRecordBundle } from '../validation/types'

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

function toInvoiceBundle(inv: { header: InvoiceRow | null; lines: InvoiceLineRow[] }): DocumentRecordBundle {
  return buildBundle(
    'invoice',
    inv.header as unknown as Record<string, unknown> | null,
    inv.lines as unknown as Array<Record<string, unknown>>,
    [],
  )
}

function toContractBundle(ctr: { header: ContractRow | null; terms: ContractTermRow[] }): DocumentRecordBundle {
  return buildBundle(
    'contract',
    ctr.header as unknown as Record<string, unknown> | null,
    [],
    ctr.terms as unknown as Array<Record<string, unknown>>,
  )
}

// Ruling R57: the row-to-item map lives here rather than in `src/db/validation.ts`
// because the one threshold it reads, `CONFIDENCE_THRESHOLD`, is exported by the
// intake workflow, which already imports `replaceValidation` from that storage
// module. The reverse edge closes a cycle and pulls `@mastra/core`, `unpdf`,
// mammoth, docling and OCR into everything that reads findings. The db layer
// returns rows; this is where a row becomes a queue item.
function toQueueItem(row: ReviewQueueRow): ReviewQueueItem {
  const lowest = row.lowest_field_confidence === null ? null : Number(row.lowest_field_confidence)
  const reasons: string[] = []
  if (row.status === 'needs_review') reasons.push('needs review')
  if (row.open_errors > 0) reasons.push('open error')
  if (row.open_warnings > 0) reasons.push('open warning')
  if (lowest !== null && lowest < CONFIDENCE_THRESHOLD) reasons.push('low confidence')
  return {
    documentId: row.document_id,
    title: row.title,
    kind: row.kind,
    status: row.status,
    confidence: row.confidence === null ? null : Number(row.confidence),
    lowestFieldConfidence: lowest,
    openErrors: row.open_errors,
    openWarnings: row.open_warnings,
    reasons,
    createdAt: toIsoString(row.created_at, 'review_queue.created_at'),
  }
}

// `offset` and `limit` become SQL parameters bound to a bigint, and `pg` cannot bind
// a value outside bigint's range. `Number.isInteger(1e30)` is true, so that test let
// a client typo through to a Postgres range error and a 500; a safe integer is what
// the parameter can actually hold, so anything else is answered 400 here.
function intQuery(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}

const MAX_WINDOW_DAYS = 365
const DEFAULT_WINDOW_DAYS = 90

// R54 and R59 together: the day an operator names is their own calendar day, so every edge
// of the window is their local midnight. `parseDate` hands back the day a string writes, as
// text (`src/validation/values.ts:41`), which is why this splits and rebuilds instead of
// parsing. A malformed day returns NaN and lands in the existing `bad_range` path rather
// than throwing — `noUncheckedIndexedAccess` means each component has to be checked before
// it is used, not asserted away.
function dayToMs(day: string): number {
  const parts = day.split('-').map(Number)
  const y = parts[0]
  const mo = parts[1]
  const d = parts[2]
  if (y === undefined || mo === undefined || d === undefined) return Number.NaN
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return Number.NaN
  return new Date(y, mo - 1, d).getTime()
}

// Whole days are added and subtracted with setDate, never with +/- 86_400_000: this box
// crossed into DST on 2026-10-04, so millisecond arithmetic lands a "local midnight" on
// 23:00 or 01:00 and the edge stops being the day boundary the label claims.
function shiftDay(ms: number, days: number): number {
  const d = new Date(ms)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

function parseAnalyticsWindow(
  from: string | undefined,
  to: string | undefined,
): { ok: true; window: AnalyticsWindow } | { ok: false; error: string } {
  const today = localDay(new Date())
  const toDay = to === undefined || to === '' ? today : parseDate(to)
  if (toDay === null) return { ok: false, error: 'bad_range' }
  const fromDay = from === undefined || from === '' ? null : parseDate(from)
  if (from !== undefined && from !== '' && fromDay === null) return { ok: false, error: 'bad_range' }

  const toDayMs = dayToMs(toDay)
  const fromMs = fromDay === null ? shiftDay(toDayMs, -(DEFAULT_WINDOW_DAYS - 1)) : dayToMs(fromDay)
  if (Number.isNaN(toDayMs) || Number.isNaN(fromMs)) return { ok: false, error: 'bad_range' }

  const toExclusiveMs = shiftDay(toDayMs, 1)
  // A DST day is 23 or 25 hours, and `to` names the last day the reader wants, so the
  // count is inclusive on both ends: rounding over 86_400_000 is correct here precisely
  // because it is only counting days, never landing on one.
  const days = Math.round((toExclusiveMs - fromMs) / 86_400_000)
  if (days < 1 || days > MAX_WINDOW_DAYS) return { ok: false, error: 'bad_range' }

  return {
    ok: true,
    window: {
      from: new Date(fromMs),
      toExclusive: new Date(toExclusiveMs),
      fromLabel: localDay(new Date(fromMs)),
      toLabel: localDay(new Date(toDayMs)),
      days,
    },
  }
}

export async function runValidationForDocument(
  identity: TenantRequestContext,
  documentId: string,
): Promise<{ openErrors: number; openWarnings: number; violations: StoredViolation[] } | null> {
  return runValidationForDocumentOn(getDbClient(), identity, documentId)
}

export async function runValidationForDocumentOn(
  client: Q,
  identity: TenantRequestContext,
  documentId: string,
): Promise<{ openErrors: number; openWarnings: number; violations: StoredViolation[] } | null> {
  const document = await getDocument(identity, documentId, client)
  if (!document || (document.kind !== 'invoice' && document.kind !== 'contract')) return null
  const bundle = document.kind === 'invoice'
    ? toInvoiceBundle(await getInvoice(identity, documentId, client))
    : toContractBundle(await getContract(identity, documentId, client))
  const violations = evaluate(bundle, { today: localDay(new Date()) }).filter((v) => isCorrectable(v.field))
  const counts = await replaceValidation(
    client, documentId, identity.tenantId, violations, RULESET_VERSION,
  )
  return { ...counts, violations: await listViolations(documentId, identity.tenantId, client) }
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

  // Ahead of `/:id` by registration order, not by router magic: registered after it,
  // this path would be answered by the `:id` handler with 400 on the uuid parse.
  app.get('/review-queue', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    const kind = c.req.query('kind')
    if (kind !== undefined && kind !== 'invoice' && kind !== 'contract') {
      return c.json({ error: 'bad_filter', param: 'kind' }, 400)
    }
    const severity = c.req.query('severity')
    if (severity !== undefined && severity !== 'error' && severity !== 'warning') {
      return c.json({ error: 'bad_filter', param: 'severity' }, 400)
    }

    const rawLimit = intQuery(c.req.query('limit'), 50)
    // R11 clamps a page above 200 instead of rejecting it, because "load more" asking
    // for 500 is a request for less precision. A limit under one is not a smaller
    // page: it promises a response that cannot carry a row, so it is refused.
    if (rawLimit === null || rawLimit < 1) {
      return c.json({ error: 'bad_filter', param: 'limit' }, 400)
    }
    const limit = Math.min(200, rawLimit)
    const cursor = c.req.query('cursor')
    if (cursor !== undefined) {
      const parsed = parseCursor(cursor)
      if (!parsed) {
        return c.json({ error: 'bad_filter', param: 'cursor' }, 400)
      }
    }

    const { rows, total, nextCursor, hasMore } = await reviewQueue(gate.identity, {
      kind: kind ?? null,
      severity: severity ?? null,
      limit,
      cursor: cursor || undefined,
    })
    return c.json({ items: rows.map(toQueueItem), total, limit, nextCursor, hasMore })
  })

  // Ruling R68: tenant-scoped, not visibility-scoped. The queue a reviewer sees next to
  // these numbers is filtered to their own documents, so the panel has to label the scope
  // of this one; the aggregates name rules, fields, sources and dates and never a document.
  app.get('/analytics/review', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const { tenantId } = gate.identity

    const parsed = parseAnalyticsWindow(c.req.query('from'), c.req.query('to'))
    if (!parsed.ok) return c.json({ error: parsed.error, maxDays: MAX_WINDOW_DAYS }, 400)

    const kind = c.req.query('kind')
    if (kind !== undefined && kind !== 'invoice' && kind !== 'contract') {
      return c.json({ error: 'bad_filter', param: 'kind' }, 400)
    }
    const kindFilter = kind === 'invoice' || kind === 'contract' ? kind : null

    return c.json(await reviewAnalytics(tenantId, parsed.window, kindFilter))
  })

  // Ruling R68: visibility-scoped, not tenant-scoped. This route emits row content
  // (`document_title`, `old_value`, `new_value`, `changed_by`, `reason`), so a tenant-only
  // predicate would let any `user` download the whole tenant's correction history as a file.
  // A `readonly` tuple has no `has`, and its `includes` will not accept a plain `string`,
  // so the query parameter is tested against a Set built from the same list Task 2 exported.
  const CHANGE_SOURCE_VALUES: ReadonlySet<string> = new Set(CHANGE_SOURCES)

  app.get('/audit/export', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    // No `tenantId` destructure. R68 passes the whole identity so the export carries the
    // same visibility predicate the detail, queue and audit routes apply.

    const parsed = parseAnalyticsWindow(c.req.query('from'), c.req.query('to'))
    if (!parsed.ok) return c.json({ error: parsed.error, maxDays: MAX_WINDOW_DAYS }, 400)

    const changeSource = c.req.query('change_source') ?? null
    if (changeSource !== null && !CHANGE_SOURCE_VALUES.has(changeSource)) {
      return c.json({ error: 'bad_filter', param: 'change_source' }, 400)
    }
    const kind = c.req.query('kind')
    if (kind !== undefined && kind !== 'invoice' && kind !== 'contract') {
      return c.json({ error: 'bad_filter', param: 'kind' }, 400)
    }
    const rawMax = intQuery(c.req.query('max'), MAX_EXPORT_ROWS)
    if (rawMax === null || rawMax < 1) return c.json({ error: 'bad_filter', param: 'max' }, 400)
    const cap = Math.min(MAX_EXPORT_ROWS, rawMax)

    const rows = await exportAuditRows(
      gate.identity, parsed.window, changeSource, kind === 'invoice' || kind === 'contract' ? kind : null, cap,
    )
    c.header('X-Export-Row-Cap', String(cap))
    if (rows.length > cap) {
      return c.json({ error: 'too_many_rows', max: cap }, 400)
    }
    if (rows.length === 0) return c.body(null, 204)

    c.header('Content-Type', 'text/csv; charset=utf-8')
    c.header(
      'Content-Disposition',
      'attachment; filename="field-audit-' + parsed.window.fromLabel + '-to-' + parsed.window.toLabel + '.csv"',
    )
    return c.body(buildAuditCsv(rows))
  })

  app.get('/:id', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)

    const doc = await getDocument(gate.identity, id.data)
    if (!doc) return c.json({ error: 'not_found' }, 404)
    const { invoice_field_confidence: _ifc, contract_field_confidence: _cfc, ...document } =
      doc as DocumentRow & Record<string, unknown>
    return c.json({ document })
  })

  app.get('/:id/invoice', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)

    const doc = await getDocument(gate.identity, id.data)
    if (!doc) return c.json({ error: 'not_found' }, 404)
    if (doc.kind !== 'invoice') return c.json({ error: 'not_an_invoice' }, 409)

    const { invoice_field_confidence: _ifc, contract_field_confidence: _cfc, ...document } =
      doc as DocumentRow & Record<string, unknown>
    const { header, lines } = await getInvoice(gate.identity, id.data)
    const { invoice_field_confidence: _ifc2, ...invoiceHeader } =
      (header ?? {}) as Record<string, unknown>
    return c.json({ document, invoice: invoiceHeader, lines })
  })

  app.get('/:id/contract', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)

    const doc = await getDocument(gate.identity, id.data)
    if (!doc) return c.json({ error: 'not_found' }, 404)
    if (doc.kind !== 'contract') return c.json({ error: 'not_a_contract' }, 409)

    const { invoice_field_confidence: _ifc, contract_field_confidence: _cfc, ...document } =
      doc as DocumentRow & Record<string, unknown>
    const { header, terms } = await getContract(gate.identity, id.data)
    const { contract_field_confidence: _cfc2, ...contractHeader } =
      (header ?? {}) as Record<string, unknown>
    return c.json({ document, contract: contractHeader, terms })
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

    // Ruling R67: this trail carries old_value, new_value, changed_by and reason, so the
    // tenant predicate alone let a `user` holding a uuid read another member's whole
    // change history. Same composition as `getDocument`: `$1` stays the tenant because
    // `docVisibility` names it there in both branches, and the document id goes in the
    // placeholder the visibility params leave free.
    const vis = docVisibility(gate.identity)
    const guardParams: unknown[] = [...vis.params, id.data]
    const docResult = await getDbClient().query<{ one: number }>(
      `SELECT 1 AS one FROM documents d
        WHERE d.id = $${guardParams.length} AND ${vis.sql}`,
      guardParams,
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

  app.get('/:id/validation', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)
    const violations = await listViolations(id.data, gate.identity.tenantId)
    const document = await getDocument(gate.identity, id.data)
    if (!document) return c.json({ error: 'not_found' }, 404)
    return c.json({
      documentId: id.data,
      rulesetVersion: violations[0]?.rulesetVersion ?? RULESET_VERSION,
      violations,
    })
  })

  app.post('/:id/validation', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)
    const result = await runValidationForDocument(gate.identity, id.data)
    if (result === null) return c.json({ error: 'not_found' }, 404)
    return c.json({
      documentId: id.data,
      rulesetVersion: RULESET_VERSION,
      violations: result.violations,
      openErrors: result.openErrors,
      openWarnings: result.openWarnings,
    })
  })

  app.post('/:id/validation/:violationId/waive', async (c) => {
    const gate = await auth(c)
    if ('error' in gate) return gate.error
    const id = IdSchema.safeParse(c.req.param('id'))
    const violationId = IdSchema.safeParse(c.req.param('violationId'))
    if (!id.success) return c.json({ error: 'id must be a uuid' }, 400)
    if (!violationId.success) return c.json({ error: 'violationId must be a uuid' }, 400)
    const body = await c.req.json<{ reason?: unknown }>().catch((): { reason?: undefined } => ({}))
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 8) {
      return c.json({ error: 'reason_required', min_length: 8 }, 400)
    }
    // `waiveViolation` is published (§ DB surface row 234) without a document id, so the
    // binding lives here: the finding must be one of the rows the path's document lists.
    const findings = await listViolations(id.data, gate.identity.tenantId)
    if (!findings.some((v) => v.id === violationId.data)) {
      return c.json({ error: 'not_found' }, 404)
    }
    const outcome = await waiveViolation(violationId.data, gate.identity.tenantId, gate.identity.userId, reason)
    if (!outcome.ok) {
      return c.json({ error: outcome.reason }, outcome.reason === 'not_found' ? 404 : 409)
    }
    const remaining = await runValidationForDocument(gate.identity, id.data)
    return c.json(
      remaining === null
        ? { violation: outcome.violation }
        : { violation: outcome.violation, openErrors: remaining.openErrors },
    )
  })

  const ALLOWED_INVOICE_FIELDS = [...INVOICE_FIELDS]
  const ALLOWED_CONTRACT_FIELDS = [...CONTRACT_FIELDS]

  interface CorrectionBody {
    value: unknown
    reason?: unknown
  }

  async function handleCorrection(
    c: Context,
    allowedFields: string[],
    tableName: 'invoices' | 'contracts',
    docKind: 'invoice' | 'contract',
  ) {
    const gate = await auth(c)
    if ('error' in gate) return gate.error

    // R58(b): the correction route was the only uuid-accepting route without an IdSchema
    // guard on `:id`, so a malformed id 500ed where its siblings 400ed.
    const idParse = IdSchema.safeParse(c.req.param('id'))
    if (!idParse.success) return c.json({ error: 'id must be a uuid' }, 400)
    const docId = idParse.data
    const field = c.req.param('field')
    const body = await c.req.json<CorrectionBody>()
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    const identity = gate.identity

    if (!field || !allowedFields.includes(field)) {
      return c.json({ error: `Field not correctable: '${field}'` }, 400)
    }

    // One authority for both halves of a correction. The raw tenant+kind SELECT this
    // route used to run applied no owner rule, while the re-validation below reads
    // through `getDocument`, which applies `docVisibility`: a `user` could correct a
    // document they may not read, and the response then described a document it had
    // never measured.
    const document = await getDocument(identity, docId)
    if (!document || document.kind !== docKind) {
      return c.json({ error: 'Document not found' }, 404)
    }

    // Use a dedicated connection so set_config + UPDATE share the same session,
    // guaranteeing the audit trigger sees the correct changed_by / change_source.
    const client: PoolClient = await getDbClient().connect()
    try {
      await client.query('BEGIN')
      await setAuditContext(client, { userId: identity.userId, changeSource: 'manual_correction' })

      // R58(a): lock the parent row BEFORE the watermark read, so two concurrent corrections
      // of the same field on the same document serialize here. Without the lock, both
      // transactions compute the same MAX(changed_at), both UPDATEs serialize on the row
      // anyway, and the second transaction's stamp SELECT finds the first one's committed
      // audit row and re-stamps it with the wrong reason. The interpolation stays behind
      // the same literal-union table guard that already protects the UPDATE.
      await client.query(
        `SELECT 1 FROM ${tableName} WHERE document_id = $1 FOR UPDATE`,
        [docId],
      )

      // The watermark is read before the UPDATE: the trigger's now() is this transaction's
      // start time, so the only row newer than the pre-update maximum is the one we are about
      // to write. The ::text cast is load-bearing: node-pg truncates a timestamptz to
      // milliseconds, and an older row with a microsecond tail would then compare newer than
      // the truncated watermark and get re-stamped — the exact H2 defect.
      const watermark = await client.query<{ at: string | null }>(
        `SELECT MAX(changed_at)::text AS at FROM document_field_audit
         WHERE document_id = $1 AND tenant_id = $2 AND field_name = $3`,
        [docId, identity.tenantId, field],
      )

      await client.query(
        `UPDATE ${tableName} SET ${field} = $1 WHERE document_id = $2`,
        [body.value, docId],
      )

      if (reason !== '') {
        const at = watermark.rows[0]?.at ?? null
        const stamped = await client.query<{ id: string }>(
          at === null
            ? `SELECT id FROM document_field_audit WHERE document_id = $1 AND tenant_id = $2 AND field_name = $3`
            : `SELECT id FROM document_field_audit
               WHERE document_id = $1 AND tenant_id = $2 AND field_name = $3 AND changed_at > $4`,
          at === null ? [docId, identity.tenantId, field] : [docId, identity.tenantId, field, at],
        )
        await client.query(
          `UPDATE document_field_audit SET reason = $1 WHERE id = ANY($2::uuid[])`,
          [reason, stamped.rows.map((r) => r.id)],
        )
      }

      const revalidated = await runValidationForDocumentOn(client, identity, docId)
      if (revalidated === null) {
        await client.query('ROLLBACK')
        return c.json({ error: 'Document not found' }, 404)
      }
      await client.query('COMMIT')
      return c.json({ success: true, ...revalidated })
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
