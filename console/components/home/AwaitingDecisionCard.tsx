'use client'

import { useQuery } from '@tanstack/react-query'

import { listPendingApprovals } from '@/lib/api'
import { relativeTime } from '@/lib/time'
import { Badge } from '@/components/ui/badge'
import { CardEmpty, CardFailure, CardLink, CardPending, HomeCard } from './HomeCard'


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
