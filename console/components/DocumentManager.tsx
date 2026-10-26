'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { get, post, uploadMultipart, describeError } from '../lib/api'
import type {
  ContractRecord,
  ContractTerm,
  CrmDocument,
  DocumentUploadResponse,
  InvoiceLine,
  InvoiceRecord,
} from '../lib/types'
import { Badge } from './ui/badge'
import { Button } from './ui/button'


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
  const [uploading, setUploading] = useState(false)
  const [selected, setSelected] = useState<CrmDocument | null>(null)
  const [detail, setDetail] = useState<InvoiceDetail | ContractDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setListError(null)
    try {
      const data = await get<ListResponse>(`/api/documents?kind=${kind}`)
      setDocuments(data.documents ?? [])
    } catch (err) {
      setListError(describeError(err))
      setDocuments([])
    } finally {
      setLoading(false)
    }
  }, [kind])

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
      const data = await uploadMultipart<DocumentUploadResponse>('/api/documents/upload', formData)
      setNotice({
        kind: data.status === 'needs_review' ? 'info' : 'ok',
        text:
          data.status === 'needs_review'
            ? `Processed ${data.documentId} but flagged it for review (confidence ${data.confidence ?? 'n/a'}).`
            : `Ingested ${data.documentId} as a ${data.kind} (${data.chunkCount} chunks indexed).`,
      })
      await load()
    } catch (err) {
      setNotice({ kind: 'bad', text: describeError(err) })
    } finally {
      setUploading(false)
    }
  }

  async function openDetail(doc: CrmDocument) {
    setSelected(doc)
    setDetail(null)
    setDetailLoading(true)
    try {
      const suffix = isInvoice ? 'invoice' : 'contract'
      const data = await get<InvoiceDetail | ContractDetail>(
        `/api/documents/${encodeURIComponent(doc.id)}/${suffix}`,
      )
      setDetail(data)
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

      {loading ? <p className="text-sm text-text-muted">Loading {label.toLowerCase()}s…</p> : null}

      {listError ? (
        <div role="alert" className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">
          <p className="break-words">{listError}</p>
          <Button variant="ghost" size="sm" onClick={() => void load()} className="mt-2 h-7 px-2 text-danger hover:bg-danger-soft hover:text-danger">
            Retry
          </Button>
        </div>
      ) : null}

      {!loading && !listError && documents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          No {label.toLowerCase()}s uploaded yet.
        </div>
      ) : null}

      {documents.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-[0.06em] text-text-muted">
                <th scope="col" className="px-3 py-2 font-medium">Title</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">Confidence</th>
                <th scope="col" className="px-3 py-2 font-medium">Updated</th>
                <th scope="col" className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} className="border-b border-border last:border-0 hover:bg-bg-hover">
                  <td className="px-3 py-2 align-top font-medium text-text-primary">{doc.title}</td>
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
                      <Button variant="outline" size="sm" onClick={() => void openDetail(doc)}>
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

      {selected ? <DocumentDetail kind={kind} detail={detail} loading={detailLoading} onClose={() => setSelected(null)} /> : null}
    </div>
  )
}

function DocumentDetail({
  kind,
  detail,
  loading,
  onClose,
}: {
  kind: 'invoice' | 'contract'
  detail: InvoiceDetail | ContractDetail | null
  loading: boolean
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
        <InvoiceView detail={detail as InvoiceDetail} />
      ) : null}

      {!loading && detail && !isInvoice && 'contract' in detail ? (
        <ContractView detail={detail as ContractDetail} />
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

function InvoiceView({ detail }: { detail: InvoiceDetail }) {
  const inv = detail.invoice
  return (
    <div className="space-y-4">
      <div>
        <Field name="Vendor" value={inv?.vendor_name ?? '—'} />
        <Field name="Invoice number" value={inv?.invoice_number ?? '—'} />
        <Field name="Invoice date" value={inv?.invoice_date ?? '—'} />
        <Field name="Due date" value={inv?.due_date ?? '—'} />
        <Field name="Currency" value={inv?.currency ?? '—'} />
        <Field name="Subtotal" value={money(inv?.subtotal)} />
        <Field name="Tax" value={money(inv?.tax)} />
        <Field name="Total" value={<span className="font-semibold">{money(inv?.total)}</span>} />
      </div>
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

function ContractView({ detail }: { detail: ContractDetail }) {
  const con = detail.contract
  return (
    <div className="space-y-4">
      <div>
        <Field name="Counterparty" value={con?.counterparty ?? '—'} />
        <Field name="Effective date" value={con?.effective_date ?? '—'} />
        <Field name="Expiry date" value={con?.expiry_date ?? '—'} />
        <Field name="Term (months)" value={con?.term_months ?? '—'} />
        <Field name="Value" value={<span className="font-semibold">{money(con?.contract_value)}</span>} />
        <Field name="Currency" value={con?.currency ?? '—'} />
        <Field name="Auto-renewal" value={con?.auto_renewal == null ? '—' : con.auto_renewal ? 'Yes' : 'No'} />
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
