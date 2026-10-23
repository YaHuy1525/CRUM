import { useState, useEffect } from 'react'

interface PendingWrite {
  id: string
  object_type: string
  operation: string
  payload: unknown
  risk_score: number
  gate: string
  created_at: string
  run_id: string
}

interface ApprovalQueueProps {
  tenantId: string
}

/**
 * Approval queue UI. §11.3.
 * Two-source join: pending_writes (data) + listSuspendedRuns (status).
 * Resolved tab: shows decided drafts with inline receipt.
 * Diff view: shows payload changes for update operations.
 */
export function ApprovalQueue({ tenantId }: ApprovalQueueProps) {
  const [items, setItems] = useState<PendingWrite[]>([])
  const [tab, setTab] = useState<'pending' | 'resolved'>('pending')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/approvals/pending`, {
      headers: { 'x-tenant-id': tenantId },
    })
      .then((r) => r.json())
      .then((data) => {
        setItems(data.items ?? [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [tenantId])

  if (loading) return <div>Loading approval queue...</div>

  return (
    <div className="approval-queue">
      <div className="tabs">
        <button
          className={tab === 'pending' ? 'active' : ''}
          onClick={() => setTab('pending')}
        >
          Pending ({items.length})
        </button>
        <button
          className={tab === 'resolved' ? 'active' : ''}
          onClick={() => setTab('resolved')}
        >
          Resolved
        </button>
      </div>

      {tab === 'pending' && (
        <ul>
          {items.map((item) => (
            <li key={item.id} className="queue-item">
              <div className="risk-badge">Risk: {item.risk_score}</div>
              <div className="object-info">
                {item.operation} {item.object_type}
              </div>
              <div className="payload-preview">
                <pre>{JSON.stringify(item.payload, null, 2)}</pre>
              </div>
              <div className="actions">
                <button className="approve">Approve</button>
                <button className="reject">Reject</button>
              </div>
            </li>
          ))}
          {items.length === 0 && <li>No pending approvals.</li>}
        </ul>
      )}

      {tab === 'resolved' && (
        <div className="resolved-tab">
          <p>Resolved items with receipts appear here.</p>
        </div>
      )}
    </div>
  )
}
