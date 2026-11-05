'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { get, post, uploadMultipart, describeError } from '../lib/api'
import type {
  ContractRecord,
  ContractTerm,
  CrmDocument,
  InvoiceLine,
  InvoiceRecord,
} from '../lib/types'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { EditableField } from './EditableField'
import { AuditTrail } from './AuditTrail'
import { FieldConfidenceChip } from './FieldConfidenceChip'
import { FindingList } from './FindingList'
import {
  getReviewQueue,
  getValidation,
  getAuditTrail,
  waiveFinding,
  revalidateDocument,
  findingsFor,
  shortTime,
} from '../lib/review'
import type {
  ReviewQueueItem,
  StoredViolation,
  AuditRow,
  CorrectionResult,
} from '../lib/review'


type Notice = { kind: 'ok' | 'bad' | 'info'; text: string }

interface ListResponse {
  documents: CrmDocument[]
  total: number
}

interface InvoiceDetail {
  document: CrmDocument
  invoice: InvoiceRecord | null
  lines: InvoiceLine[]
}

interface ContractDetail {
  document: CrmDocument
  contract: ContractRecord | null
  terms: ContractTerm[]
}

function statusVariant(status: CrmDocument['status']): 'success' | 'warning' | 'danger' {
  if (status === 'ready') return 'success'
  if (status === 'failed') return 'danger'
  return 'warning'
}

function money(value: string | null | undefined): string {
  if (value == null || value === '') return '—'
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : value
}

export function DocumentManager({ kind }: { kind: 'invoice' | 'contract' }) {
  const isInvoice = kind === 'invoice'
  const label = isInvoice ? 'Invoice' : 'Contract'

  const [documents, setDocuments] = useState<CrmDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [_uploading, setUploading] = useState(false)
  const [processingJobs, setProcessingJobs] = useState<Map<string, { fileName: string; status: string }>>(new Map())
  const [selected, setSelected] = useState<CrmDocument | null>(null)
  const [detail, setDetail] = useState<InvoiceDetail | ContractDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [reviewMode, setReviewMode] = useState(false)
  const [queue, setQueue] = useState<ReviewQueueItem[]>([])
  const [violations, setViolations] = useState<StoredViolation[]>([])
  const [auditRows, setAuditRows] = useState<AuditRow[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      // The queued job outlives the page that queued it; the two-minute poll
      // must not. Without this the loop keeps hitting the status endpoint after
      // unmount, and the tests that follow it inherit the requests.
      aliveRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setListError(null)
    try {
      if (reviewMode) {
        const data = await getReviewQueue(`?kind=${kind}`)
        setQueue(data.items)
        setDocuments([])
      } else {
        const data = await get<ListResponse>(`/api/documents?kind=${kind}`)
        setDocuments(data.documents ?? [])
        setQueue([])
      }
    } catch (err) {
      setListError(describeError(err))
      setDocuments([])
      setQueue([])
    } finally {
      setLoading(false)
    }
  }, [kind, reviewMode])

  useEffect(() => {
    void load()
  }, [load])

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (!file) return

    setUploading(true)
    setNotice(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const data = await uploadMultipart<{ jobId: string; fileId: string; status: string; message: string }>(
        '/api/documents/upload',
        formData,
      )
      
      setProcessingJobs((prev) => {
        const next = new Map(prev)
        next.set(data.jobId, { fileName: file.name, status: 'queued' })
        return next
      })
      
      setNotice({
        kind: 'info',
        text: `${file.name} queued for processing. Job ID: ${data.jobId}`,
      })
      
      void pollJobStatus(data.jobId)
    } catch (err) {
      setNotice({ kind: 'bad', text: describeError(err) })
    } finally {
      setUploading(false)
    }
  }

  async function pollJobStatus(jobId: string) {
    const maxAttempts = 60
    const pollInterval = 2000
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval))
      if (!aliveRef.current) return
      
      try {
        const status = await get<{
          id: string
          state: string
          progress: number | object
          result?: { documentId: string; status: string; kind?: string; confidence?: number }
          failedReason?: string
        }>(`/api/documents/status/${jobId}`)
        
        setProcessingJobs((prev) => {
          const next = new Map(prev)
          const job = next.get(jobId)
          if (job) {
            next.set(jobId, { ...job, status: status.state })
          }
          return next
        })
        
        if (status.state === 'completed') {
          const result = status.result
          setProcessingJobs((prev) => {
            const next = new Map(prev)
            next.delete(jobId)
            return next
          })
          setNotice({
            kind: 'ok',
            text: `Document processed successfully: ${result?.documentId}`,
          })
          await load()
          return
        }
        
        if (status.state === 'failed') {
          setProcessingJobs((prev) => {
            const next = new Map(prev)
            next.delete(jobId)
            return next
          })
          setNotice({
            kind: 'bad',
            text: `Document processing failed: ${status.failedReason || 'Unknown error'}`,
          })
          return
        }
      } catch (err) {
        console.error('Failed to poll job status:', err)
      }
    }
    
    setProcessingJobs((prev) => {
      const next = new Map(prev)
      next.delete(jobId)
      return next
    })
    setNotice({
      kind: 'info',
      text: 'Document processing is taking longer than expected. Check the documents list for updates.',
    })
  }

  async function openDetail(documentId: string, _title: string) {
    setDetail(null)
    setDetailLoading(true)
    setViolations([])
    setAuditRows([])
    const suffix = isInvoice ? 'invoice' : 'contract'
    try {
      const data = await get<InvoiceDetail | ContractDetail>(
        `/api/documents/${encodeURIComponent(documentId)}/${suffix}`,
      )
      setDetail(data)
      setSelected(data.document)
      if (reviewMode) {
        const [validation, audit] = await Promise.all([
          getValidation(documentId),
          getAuditTrail(documentId),
        ])
        setViolations(validation.violations)
        setAuditRows(audit.audit)
      }
    } catch (err) {
      setNotice({ kind: 'bad', text: describeError(err) })
    } finally {
      setDetailLoading(false)
    }
  }

  async function handleReview(doc: CrmDocument) {
    setNotice(null)
    try {
      await post(`/api/documents/${encodeURIComponent(doc.id)}/review`)
      setNotice({ kind: 'ok', text: `Confirmed ${doc.title} as ready.` })
      await load()
      if (selected?.id === doc.id) setSelected(null)
    } catch (err) {
      setNotice({ kind: 'bad', text: describeError(err) })
    }
  }

  async function recheck(documentId: string) {
    const data = await revalidateDocument(documentId)
    setViolations(data.violations)
    await load()
  }

  async function refreshAudit(documentId: string) {
    setAuditRows((await getAuditTrail(documentId)).audit)
  }

  async function waive(documentId: string, violationId: string, reason: string) {
    await waiveFinding(documentId, violationId, reason)
    setViolations((await getValidation(documentId)).violations)
    await load()
  }

  function applyCorrection(result: CorrectionResult) {
    setViolations(result.violations)
    if (selected) void refreshAudit(selected.id)
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          aria-label={`Upload a ${label.toLowerCase()}`}
          onChange={(e) => void handleFile(e)}
          className="focus-ring block w-full max-w-sm cursor-pointer rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text-secondary file:mr-3 file:cursor-pointer file:rounded file:border-0 file:bg-accent file:px-3 file:py-1 file:text-sm file:text-accent-fg"
        />
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
        <Button
          variant={reviewMode ? 'default' : 'ghost'}
          size="sm"
          onClick={() => setReviewMode((m) => !m)}
        >
          {reviewMode ? `Needs review (${queue.length})` : 'Needs review'}
        </Button>
        {reviewMode && documents.length === 0 && queue.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setReviewMode(false)}>All {label.toLowerCase()}s</Button>
        ) : null}
      </div>

      {notice ? (
        <p
          role={notice.kind === 'bad' ? 'alert' : 'status'}
          className={
            notice.kind === 'bad'
              ? 'rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger'
              : notice.kind === 'ok'
                ? 'rounded-md border border-success-line bg-success-soft px-3 py-2 text-sm text-success'
                : 'rounded-md border border-border bg-bg-raised px-3 py-2 text-sm text-text-secondary'
          }
        >
          {notice.text}
        </p>
      ) : null}

      {processingJobs.size > 0 ? (
        <div className="rounded-md border border-border bg-bg-raised px-3 py-2">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Processing</p>
          <ul className="space-y-1 text-sm text-text-secondary">
            {Array.from(processingJobs.entries()).map(([jobId, { fileName, status }]) => (
              <li key={jobId} className="flex items-center justify-between">
                <span>{fileName}</span>
                <Badge variant={status === 'completed' ? 'success' : status === 'failed' ? 'danger' : 'warning'}>
                  {status}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {loading ? <p className="text-sm text-text-muted">Loading {label.toLowerCase()}s…</p> : null}

      {listError ? (
        <div role="alert" className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">
          <p className="break-words">{listError}</p>
          <Button variant="ghost" size="sm" onClick={() => void load()} className="mt-2 h-7 px-2 text-danger hover:bg-danger-soft hover:text-danger">
            Retry
          </Button>
        </div>
      ) : null}

      {!loading && !listError && documents.length === 0 && !(reviewMode && queue.length > 0) ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          No {label.toLowerCase()}s uploaded yet.
        </div>
      ) : null}

      {(documents.length > 0 || (reviewMode && queue.length > 0)) ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-[0.06em] text-text-muted">
                <th scope="col" className="px-3 py-2 font-medium">Title</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">Confidence</th>
                {reviewMode ? <th scope="col" className="px-3 py-2 font-medium">Findings</th> : null}
                <th scope="col" className="px-3 py-2 font-medium">Updated</th>
                <th scope="col" className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {reviewMode
                ? queue.map((item) => (
                    <tr key={item.documentId} className="border-b border-border last:border-0">
                      <td className="px-3 py-2">
                        <button type="button" className="text-left text-text-primary hover:underline"
                          onClick={() => void openDetail(item.documentId, item.title)}>
                          {item.title}
                        </button>
                      </td>
                      <td className="px-3 py-2"><Badge variant={statusVariant(item.status as CrmDocument['status'])}>{item.status}</Badge></td>
                      <td className="px-3 py-2"><FieldConfidenceChip value={item.lowestFieldConfidence} /></td>
                      <td className="px-3 py-2 text-text-muted">{item.reasons.map((r) => <span key={r} className="mr-1">{r}</span>)}</td>
                      <td className="px-3 py-2 text-text-muted">{shortTime(item.createdAt)}</td>
                    </tr>
                  ))
                : documents.map((doc) => (
                    <tr key={doc.id} className="border-b border-border last:border-0 hover:bg-bg-hover">
                      <td className="px-3 py-2 align-top font-medium text-text-primary">
                        <button type="button" className="text-left hover:underline"
                          onClick={() => void openDetail(doc.id, doc.title)}>
                          {doc.title}
                        </button>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <Badge variant={statusVariant(doc.status)}>{doc.status}</Badge>
                      </td>
                      <td className="px-3 py-2 align-top font-mono text-xs text-text-secondary">
                        {doc.confidence == null ? '—' : `${Math.round(Number(doc.confidence) * 100)}%`}
                      </td>
                      <td className="px-3 py-2 align-top text-xs text-text-muted">
                        {new Date(doc.updated_at).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="flex flex-wrap gap-2">
                          <Button variant="outline" size="sm" onClick={() => void openDetail(doc.id, doc.title)}>
                            View
                          </Button>
                          {doc.status === 'needs_review' ? (
                            <Button variant="ghost" size="sm" onClick={() => void handleReview(doc)}>
                              Confirm
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {selected ? (
        <DocumentDetail
          kind={kind}
          detail={detail}
          loading={detailLoading}
          editable={reviewMode}
          violations={violations}
          auditRows={auditRows}
          onCorrected={applyCorrection}
          onWaive={waive}
          onRecheck={recheck}
          onRefreshAudit={refreshAudit}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  )
}

function DocumentDetail({
  kind,
  detail,
  loading,
  editable,
  violations,
  auditRows,
  onCorrected,
  onWaive,
  onRecheck,
  onRefreshAudit,
  onClose,
}: {
  kind: 'invoice' | 'contract'
  detail: InvoiceDetail | ContractDetail | null
  loading: boolean
  editable: boolean
  violations: StoredViolation[]
  auditRows: AuditRow[]
  onCorrected: (result: CorrectionResult) => void
  onWaive: (documentId: string, violationId: string, reason: string) => Promise<void>
  onRecheck: (documentId: string) => Promise<void>
  onRefreshAudit: (documentId: string) => Promise<void>
  onClose: () => void
}) {
  const isInvoice = kind === 'invoice'
  return (
    <div className="rounded-lg border border-border bg-bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">
          {isInvoice ? 'Invoice detail' : 'Contract detail'}
          {detail ? ` — ${detail.document.title}` : ''}
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      {loading ? <p className="text-sm text-text-muted">Loading…</p> : null}

      {!loading && detail && isInvoice && 'invoice' in detail ? (
        <InvoiceView detail={detail} editable={editable} violations={violations} onCorrected={onCorrected} onWaive={onWaive} />
      ) : null}

      {!loading && detail && !isInvoice && 'contract' in detail ? (
        <ContractView detail={detail} editable={editable} violations={violations} onCorrected={onCorrected} onWaive={onWaive} />
      ) : null}

      {editable && detail ? (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <AuditTrail rows={auditRows} onReload={() => void onRefreshAudit(detail.document.id)} />
          <Button variant="ghost" size="sm" onClick={() => void onRecheck(detail.document.id)}>re-check</Button>
        </div>
      ) : null}
    </div>
  )
}

function Field({ name, value }: { name: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border py-1 text-sm last:border-0">
      <span className="text-text-muted">{name}</span>
      <span className="text-right text-text-primary">{value}</span>
    </div>
  )
}

type InvoiceViewProps = {
  detail: InvoiceDetail
  editable: boolean
  violations: StoredViolation[]
  onCorrected: (result: CorrectionResult) => void
  onWaive: (documentId: string, violationId: string, reason: string) => Promise<void>
}

function InvoiceView({ detail, editable, violations, onCorrected, onWaive }: InvoiceViewProps) {
  const inv = detail.invoice
  const conf = detail.document instanceof Object && 'field_confidence' in detail.document
    ? (detail.document as { field_confidence?: Record<string, number> | null }).field_confidence ?? null
    : null
  const row = (column: keyof InvoiceRecord, label: string, display: React.ReactNode) => {
    const fieldFindings = findingsFor(violations, String(column))
    return editable && fieldFindings.length > 0 ? (
      <EditableField
        key={column}
        documentId={detail.document.id}
        tableName="invoices"
        field={String(column)}
        label={label}
        value={inv?.[column] == null ? '' : String(inv[column])}
        confidence={conf?.[String(column)]}
        findings={fieldFindings}
        requiredReason={fieldFindings.some((v) => v.severity === 'error' && v.status === 'open')}
        onCorrected={onCorrected}
        onWaive={(id, reason) => onWaive(detail.document.id, id, reason)}
      />
    ) : (
      <Field key={column} name={label} value={display} />
    )
  }

  return (
    <div className="space-y-4">
      <div>
        {row('vendor_name', 'Vendor', inv?.vendor_name ?? '—')}
        {row('invoice_number', 'Invoice number', inv?.invoice_number ?? '—')}
        {row('invoice_date', 'Invoice date', inv?.invoice_date ?? '—')}
        {row('due_date', 'Due date', inv?.due_date ?? '—')}
        {row('currency', 'Currency', inv?.currency ?? '—')}
        {row('subtotal', 'Subtotal', money(inv?.subtotal))}
        {row('tax', 'Tax', money(inv?.tax))}
        {row('total', 'Total', <span className="font-semibold">{money(inv?.total)}</span>)}
      </div>
      {findingsFor(violations, 'lines.amount').length > 0 ? (
        <FindingList violations={findingsFor(violations, 'lines.amount')} onWaive={(id, r) => onWaive(detail.document.id, id, r)} />
      ) : null}
      <div>
        <p className="mb-1 text-xs uppercase tracking-[0.06em] text-text-muted">Line items</p>
        {detail.lines.length === 0 ? (
          <p className="text-sm text-text-muted">None extracted.</p>
        ) : (
          <ul className="space-y-1 text-sm text-text-secondary">
            {detail.lines.map((line, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>{line.description ?? '—'}</span>
                <span className="font-mono text-xs">{money(line.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

type ContractViewProps = {
  detail: ContractDetail
  editable: boolean
  violations: StoredViolation[]
  onCorrected: (result: CorrectionResult) => void
  onWaive: (documentId: string, violationId: string, reason: string) => Promise<void>
}

function ContractView({ detail, editable, violations, onCorrected, onWaive }: ContractViewProps) {
  const con = detail.contract
  const conf = detail.document instanceof Object && 'field_confidence' in detail.document
    ? (detail.document as { field_confidence?: Record<string, number> | null }).field_confidence ?? null
    : null
  const row = (column: keyof ContractRecord, label: string, display: React.ReactNode) => {
    const fieldFindings = findingsFor(violations, String(column))
    return editable && fieldFindings.length > 0 ? (
      <EditableField
        key={column}
        documentId={detail.document.id}
        tableName="contracts"
        field={String(column)}
        label={label}
        value={con?.[column] == null ? '' : String(con[column])}
        confidence={conf?.[String(column)]}
        findings={fieldFindings}
        requiredReason={fieldFindings.some((v) => v.severity === 'error' && v.status === 'open')}
        onCorrected={onCorrected}
        onWaive={(id, reason) => onWaive(detail.document.id, id, reason)}
      />
    ) : (
      <Field key={column} name={label} value={display} />
    )
  }

  return (
    <div className="space-y-4">
      <div>
        {row('counterparty', 'Counterparty', con?.counterparty ?? '—')}
        {row('effective_date', 'Effective date', con?.effective_date ?? '—')}
        {row('expiry_date', 'Expiry date', con?.expiry_date ?? '—')}
        {row('term_months', 'Term (months)', con?.term_months ?? '—')}
        {row('contract_value', 'Value', <span className="font-semibold">{money(con?.contract_value)}</span>)}
        {row('currency', 'Currency', con?.currency ?? '—')}
        {row('auto_renewal', 'Auto-renewal', con?.auto_renewal == null ? '—' : con.auto_renewal ? 'Yes' : 'No')}
      </div>
      <div>
        <p className="mb-1 text-xs uppercase tracking-[0.06em] text-text-muted">Key terms</p>
        {detail.terms.length === 0 ? (
          <p className="text-sm text-text-muted">None extracted.</p>
        ) : (
          <ul className="space-y-2 text-sm text-text-secondary">
            {detail.terms.map((term, i) => (
              <li key={i}>
                <span className="font-medium text-text-primary">{term.title ?? term.clause_type ?? 'Term'}</span>
                {term.text ? <p className="text-xs text-text-muted">{term.text}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
