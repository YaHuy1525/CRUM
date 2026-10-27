'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'

import { listThreads } from '@/lib/api'
import { relativeTime } from '@/lib/time'
import { CardEmpty, CardFailure, CardLink, CardPending, HomeCard } from './HomeCard'


const RECENT_ROWS = 5

export function RecentConversationsCard() {
  const threads = useQuery({ queryKey: ['home', 'threads'], queryFn: listThreads })

  const rows = threads.data?.sessions.slice(0, RECENT_ROWS) ?? []

  return (
    <HomeCard title="Recent conversations" action={<CardLink href="/chats">All conversations</CardLink>}>
      {threads.isPending ? <CardPending label="recent conversations" /> : null}

      {threads.isError ? (
        <CardFailure
          error={threads.error}
          onRetry={() => void threads.refetch()}
          label="Retry loading recent conversations"
        />
      ) : null}

      {threads.isSuccess && rows.length === 0 ? (
        <CardEmpty>
          No conversations yet. <CardLink href="/chats/new">Start one</CardLink>.
        </CardEmpty>
      ) : null}

      {threads.isSuccess && rows.length > 0 ? (
        <ul className="space-y-1">
          {rows.map((thread) => (
            <li key={thread.id}>
              <Link
                href={`/chats/${thread.id}`}
                className="flex items-baseline justify-between gap-3 rounded-md px-1 py-1 text-sm text-text-secondary transition-colors hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="min-w-0 truncate">{thread.title || 'Untitled conversation'}</span>
                <span className="shrink-0 text-xs text-text-muted">
                  {relativeTime(thread.updated_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </HomeCard>
  )
}
