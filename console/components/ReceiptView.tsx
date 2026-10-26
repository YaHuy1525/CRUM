'use client'

import { useCallback, useEffect, useState } from 'react'

import { get, describeError } from '../lib/api'
import type { ReceiptResponse } from '../lib/types'
import { Badge } from './ui/badge'

/**
 * Inline receipt display with a real signature verdict. §11.3, §12.3.
 *
 * It replaces the placeholder that printed "Signature verification: pending
 * integration" forever. `GET /api/approvals/receipts/:id` recomputes the HMAC over
 * the fields the signature covered and answers three things, and the third is the
 * one a reviewer needs: `verification` is `valid`, `invalid`, **or** `unavailable`,
 * because "the secret is not configured here" is not the same claim as "this
 * signature is wrong". Rendering `unavailable` as a failure would accuse an
 * innocent audit trail of forgery.
 *
 * The verdict is a badge on the three state tokens, so an unavailable signature
 * reads as attention rather than as either green or red. The body is a definition
 * list because it is a record: every row is a label and its value, not prose.
 */

interface ReceiptViewProps {
  receiptId: string
}

const VERDICT_LABEL: Record<ReceiptResponse['verification'], string> = {
  valid: 'Signature verified',
  invalid: 'Signature DOES NOT match this receipt',
  unavailable: 'Signature could not be verified (APPROVAL_HMAC_SECRET unset or rotated)',
}

const VERDICT_VARIANT: Record<ReceiptResponse['verification'], 'success' | 'danger' | 'warning'> = {
  valid: 'success',
  invalid: 'danger',
  unavailable: 'warning',
}

/** One label/value pair. Kept local: a receipt row is never reused elsewhere. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-text-secondary">{children}</dd>
    </>
  )
}

export function ReceiptView({ receiptId }: ReceiptViewProps) {
  const [data, setData] = useState<ReceiptResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await get<ReceiptResponse>(`/api/approvals/receipts/${encodeURIComponent(receiptId)}`))
    } catch (err) {
      setError(describeError(err))
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [receiptId])

  useEffect(() => {
    void load()
  }, [load])

  // No live-region role while reading: the queue already announces its own
  // outcomes, and a second status here would answer for the wrong control.
  if (loading) {
    return (
      <p className="mt-2 text-xs text-text-muted" data-testid="receipt-loading">
        Loading receipt {receiptId}…
      </p>
    )
  }

  if (error || !data) {
    return (
      <div
        role="alert"
        className="mt-2 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
      >
        Receipt {receiptId}: {error ?? 'no data'}
      </div>
    )
  }

  const { receipt, verification } = data

  return (
    <div className="mt-2 rounded-md border border-border bg-bg-base p-3 text-sm">
      <h4 className="flex flex-wrap items-center gap-2 font-medium text-text-primary">
        <span>
          Receipt <span className="font-mono text-xs">{receipt.id.slice(0, 8)}</span>
        </span>
        <Badge variant={VERDICT_VARIANT[verification]} data-verdict={verification}>
          {VERDICT_LABEL[verification]}
        </Badge>
      </h4>

      <dl className="mt-3 grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1">
        <Row label="Decision">{receipt.decision}</Row>
        <Row label="Approved by">{receipt.approved_by}</Row>
        <Row label="Scope">{receipt.scope}</Row>
        <Row label="Draft">{receipt.pending_write_id}</Row>
        <Row label="Run">{receipt.run_id}</Row>
        {receipt.committed_record_id ? (
          <Row label="Record written">{receipt.committed_record_id}</Row>
        ) : null}
        {receipt.reason ? <Row label="Reason">{receipt.reason}</Row> : null}
        <Row label="Signed at">{new Date(receipt.created_at).toLocaleString()}</Row>
        {/* Truncated: the full HMAC belongs in an export, not in a panel a screen
            reader has to walk through. */}
        <Row label="Signature">
          <code className="font-mono text-xs">{`${receipt.signature.slice(0, 16)}…`}</code>
        </Row>
      </dl>
    </div>
  )
}
