'use client'

import { useCallback, useEffect, useState } from 'react'
import { get, describeError } from '../lib/api'
import type { ReceiptResponse } from '../lib/types'

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
 */

interface ReceiptViewProps {
  receiptId: string
}

const VERDICT_LABEL: Record<ReceiptResponse['verification'], string> = {
  valid: 'Signature verified',
  invalid: 'Signature DOES NOT match this receipt',
  unavailable: 'Signature could not be verified (APPROVAL_HMAC_SECRET unset or rotated)',
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

  if (loading) return <div className="receipt-view">Loading receipt {receiptId}…</div>

  if (error || !data) {
    return (
      <div className="receipt-view error" role="alert">
        Receipt {receiptId}: {error ?? 'no data'}
      </div>
    )
  }

  const { receipt, verification } = data

  return (
    <div className="receipt-view">
      <h4>
        Receipt {receipt.id.slice(0, 8)} —{' '}
        <span className={`verdict verdict-${verification}`}>{VERDICT_LABEL[verification]}</span>
      </h4>
      <dl>
        <dt>Decision</dt>
        <dd>{receipt.decision}</dd>
        <dt>Approved by</dt>
        <dd>{receipt.approved_by}</dd>
        <dt>Scope</dt>
        <dd>{receipt.scope}</dd>
        <dt>Draft</dt>
        <dd>{receipt.pending_write_id}</dd>
        <dt>Run</dt>
        <dd>{receipt.run_id}</dd>
        {receipt.committed_record_id && (
          <>
            <dt>Record written</dt>
            <dd>{receipt.committed_record_id}</dd>
          </>
        )}
        {receipt.reason && (
          <>
            <dt>Reason</dt>
            <dd>{receipt.reason}</dd>
          </>
        )}
        <dt>Signed at</dt>
        <dd>{new Date(receipt.created_at).toLocaleString()}</dd>
        <dt>Signature</dt>
        {/* Truncated: the full HMAC belongs in an export, not in a panel a screen
            reader has to walk through. */}
        <dd>
          <code>{`${receipt.signature.slice(0, 16)}…`}</code>
        </dd>
      </dl>
    </div>
  )
}
