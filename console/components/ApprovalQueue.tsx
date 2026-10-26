'use client'

import { useCallback, useEffect, useState } from 'react'

import { ApiError, get, post, describeError } from '../lib/api'
import type { DecisionResponse, QueueItem, QueueResponse } from '../lib/types'
import { PageHeader } from './PageHeader'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Tabs, TabsList, TabsTrigger } from './ui/tabs'
import { ReceiptView } from './ReceiptView'


type Tab = 'pending' | 'resolved'

interface Feedback {
  kind: 'ok' | 'bad'
  text: string
}

function decisionState(item: QueueItem): 'decidable' | 'expired' | 'decided' {
  if (item.receipt_id || item.rejected_at) return 'decided'
  if (item.committed_at) return 'decided'
  if (new Date(item.expires_at).getTime() <= Date.now()) return 'expired'
  return 'decidable'
}

function riskVariant(score: number): 'danger' | 'warning' | 'secondary' {
  if (score >= 70) return 'danger'
  if (score >= 40) return 'warning'
  return 'secondary'
}

export function ApprovalQueue() {
  const [tab, setTab] = useState<Tab>('pending')
  const [items, setItems] = useState<QueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Record<string, Feedback | undefined>>({})
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const [openReceipt, setOpenReceipt] = useState<string | null>(null)
  const [justDecided, setJustDecided] = useState<{ draftId: string; receiptId: string; approved: boolean } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setListError(null)
    try {
      const path = tab === 'pending' ? '/api/approvals/pending' : '/api/approvals/resolved'
      const data = await get<QueueResponse>(path)
      setItems(data.items ?? [])
    } catch (err) {
      setListError(describeError(err))
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => {
    void load()
  }, [load])

  async function decide(item: QueueItem, approved: boolean) {
    setPending((p) => ({ ...p, [item.id]: true }))
    setFeedback((f) => ({ ...f, [item.id]: undefined }))
    try {
      const body: { approved: boolean; reason?: string } = { approved }
      if (!approved) body.reason = 'Rejected from the approval queue'
      const result = await post<DecisionResponse>(
        `/api/approvals/drafts/${encodeURIComponent(item.id)}/decision`,
        body,
      )
      setFeedback((f) => ({
        ...f,
        [item.id]: {
          kind: 'ok',
          text:
            result.status === 'approved'
              ? `Committed. Receipt ${result.receipt_id ?? '(none returned)'}.`
              : `Rejected. Receipt ${result.receipt_id ?? '(none returned)'}.`,
        },
      }))
      if (result.receipt_id) {
        setJustDecided({ draftId: item.id, receiptId: result.receipt_id, approved })
      }
      await load()
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined
      const text =
        code === 'already_decided'
          ? 'Already decided — this draft has been consumed. The list has been refreshed.'
          : code === 'expired'
            ? 'The approval window closed. Re-run the request to stage a fresh draft.'
            : code === 'not_committable'
              ? `This build cannot apply the draft: ${err instanceof ApiError ? (err.detail ?? '') : ''}`
              : describeError(err)
      setFeedback((f) => ({ ...f, [item.id]: { kind: 'bad', text } }))
      if (code === 'already_decided' || code === 'expired') await load()
    } finally {
      setPending((p) => ({ ...p, [item.id]: false }))
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
      <PageHeader
        title="Governance"
        description="Every write to the CRM waits here for a human decision."
        actions={
          tab === 'pending' && !loading && !listError && items.length > 0 ? (
            <Badge variant="warning">{items.length} awaiting</Badge>
          ) : undefined
        }
      />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={(next) => setTab(next as Tab)}>
          <TabsList aria-label="Queue state">
            <TabsTrigger value="pending">Pending</TabsTrigger>
            <TabsTrigger value="resolved">Decided</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button variant="outline" size="sm" onClick={() => void load()} aria-label="Refresh queue">
          Reload
        </Button>
      </div>

      {loading ? <p className="mt-4 text-sm text-text-muted">Loading approval queue…</p> : null}

      {listError ? (
        <div
          role="alert"
          className="mt-4 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          <p className="break-words">{listError}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            className="mt-2 h-7 px-2 text-danger hover:bg-danger-soft hover:text-danger"
          >
            Retry
          </Button>
        </div>
      ) : null}

      {justDecided ? (
        <div className="mt-4 rounded-lg border border-success-line bg-success-soft p-4">
          <p className="text-sm text-text-secondary">
            {justDecided.approved ? 'Approved' : 'Rejected'} draft{' '}
            <code className="font-mono text-text-primary">{justDecided.draftId.slice(0, 8)}</code> -
            the signed receipt is the evidence it happened:
          </p>
          <ReceiptView receiptId={justDecided.receiptId} />
        </div>
      ) : null}

      {!loading && !listError && items.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          {tab === 'pending' ? 'Nothing waiting for a decision.' : 'No decisions recorded yet.'}
        </div>
      ) : null}

      <ul className="mt-4 space-y-3">
        {items.map((item) => {
          const state = decisionState(item)
          const note = feedback[item.id]
          return (
            <li key={item.id} className="rounded-lg border border-border bg-bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-text-primary">
                    {item.operation} {item.object_type}
                    {item.target_id ? ` (${item.target_id})` : ''} · gate {item.gate}
                  </p>

                  {tab === 'pending' ? (
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
                      <span>Requested by {item.requested_by}</span>
                      <span>
                        {state === 'expired' ? (
                          <em>Expired {new Date(item.expires_at).toLocaleString()}</em>
                        ) : (
                          <em>Expires {new Date(item.expires_at).toLocaleString()}</em>
                        )}
                      </span>
                      {item.suspension ? <span>Suspended run {item.suspension.run_id}</span> : null}
                    </div>
                  ) : (
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
                      {item.committed_at ? (
                        <span>Committed {new Date(item.committed_at).toLocaleString()}</span>
                      ) : null}
                      {item.rejected_at ? (
                        <span>Rejected {new Date(item.rejected_at).toLocaleString()}</span>
                      ) : null}
                      {item.committed_record_id ? <span>Record {item.committed_record_id}</span> : null}
                    </div>
                  )}
                </div>

                <Badge variant={riskVariant(item.risk_score)}>Risk: {item.risk_score}</Badge>
              </div>

              <pre className="mt-3 max-h-64 overflow-auto rounded-md border border-border bg-bg-sunken p-3 font-mono text-xs leading-relaxed text-text-secondary">
                {JSON.stringify(item.payload, null, 2)}
              </pre>

              {tab === 'pending' && state === 'decidable' ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    disabled={pending[item.id] === true}
                    onClick={() => void decide(item, true)}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="outline"
                    disabled={pending[item.id] === true}
                    onClick={() => void decide(item, false)}
                  >
                    Reject
                  </Button>
                </div>
              ) : null}

              {tab === 'pending' && state !== 'decidable' ? (
                <p className="mt-3 text-sm text-text-muted">
                  {state === 'expired'
                    ? 'No decision possible: the window has closed.'
                    : 'Already decided; see the Decided tab.'}
                </p>
              ) : null}

              {note ? (
                <p
                  role="status"
                  className={
                    note.kind === 'ok'
                      ? 'mt-3 rounded-md border border-success-line bg-success-soft px-3 py-2 text-sm text-success'
                      : 'mt-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger'
                  }
                >
                  {note.text}
                </p>
              ) : null}

              {item.receipt_id ? (
                <div className="mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setOpenReceipt(openReceipt === item.receipt_id ? null : item.receipt_id)
                    }
                    aria-expanded={openReceipt === item.receipt_id}
                  >
                    {openReceipt === item.receipt_id ? 'Hide' : 'Show'} receipt
                  </Button>
                  {openReceipt === item.receipt_id ? (
                    <ReceiptView receiptId={item.receipt_id} />
                  ) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
