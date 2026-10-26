'use client'

import { useQuery } from '@tanstack/react-query'

import { listPendingApprovals } from '@/lib/api'
import { relativeTime } from '@/lib/time'
import { Badge } from '@/components/ui/badge'
import { CardEmpty, CardFailure, CardLink, CardPending, HomeCard } from './HomeCard'

/**
 * The queue at a glance. §"Route map": Home's "awaiting decision card".
 *
 * The read is `GET /api/approvals/pending`, the same endpoint `/governance` uses,
 * so the count cannot disagree with the queue it points at. It replaced the old
 * inline `RailPulse` fetch, which had no test and rendered its own `--` for a
 * failure — a shape that reads as "no queue" at a glance.
 *
 * The list is capped at three rows. This is a pointer to the queue, not a second
 * queue: acting on a draft belongs on `/governance`, where the payload, the risk
 * gate, and the receipt are all on screen.
 */

const PREVIEW_ROWS = 3

export function AwaitingDecisionCard() {
  const approvals = useQuery({
    queryKey: ['home', 'awaiting-decision'],
    queryFn: listPendingApprovals,
  })

  const total = approvals.data?.total ?? 0
  const rows = approvals.data?.items.slice(0, PREVIEW_ROWS) ?? []

  return (
    <HomeCard
      title="Awaiting decision"
      action={<CardLink href="/governance">Open governance</CardLink>}
    >
      {approvals.isPending ? <CardPending label="the approval queue" /> : null}

      {approvals.isError ? (
        <CardFailure
          error={approvals.error}
          onRetry={() => void approvals.refetch()}
          label="Retry loading the approval queue"
        />
      ) : null}

      {approvals.isSuccess && total === 0 ? (
        <CardEmpty>Nothing is waiting on you. Staged drafts land here for a decision.</CardEmpty>
      ) : null}

      {approvals.isSuccess && total > 0 ? (
        <div>
          <p className="flex items-baseline gap-2">
            <span className="font-display text-3xl text-text-primary">{total}</span>
            <span className="text-sm text-text-muted">
              {total === 1 ? 'draft awaiting a decision' : 'drafts awaiting a decision'}
            </span>
          </p>

          <ul className="mt-3 space-y-2">
            {rows.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-text-secondary">
                  {item.object_type.replace(/_/g, ' ')} · {item.operation}
                </span>
                <Badge variant={item.gate === 'block' ? 'danger' : 'warning'}>{item.gate}</Badge>
                <span className="shrink-0 text-xs text-text-muted">
                  {relativeTime(item.created_at)}
                </span>
              </li>
            ))}
          </ul>

          {total > rows.length ? (
            <p className="mt-2 text-xs text-text-muted">
              and {total - rows.length} more in the queue
            </p>
          ) : null}
        </div>
      ) : null}
    </HomeCard>
  )
}
