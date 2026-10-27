'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'

import { getDigest } from '@/lib/api'
import { CardEmpty, CardFailure, CardLink, CardPending, HomeCard } from './HomeCard'


const ROWS = [
  { key: 'overdue', label: 'Overdue tasks', href: '/records?object=tasks' },
  { key: 'todaySchedule', label: 'Scheduled today', href: '/records?object=schedules' },
  { key: 'staleFollowups', label: 'Stale follow-ups', href: '/records?object=followups' },
] as const

function localDate(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export function TodayCard() {
  const [date, setDate] = useState('')

  useEffect(() => {
    setDate(localDate())
  }, [])

  const digest = useQuery({
    queryKey: ['home', 'today', date],
    queryFn: () => getDigest(date),
    enabled: date.length > 0,
  })

  const total = digest.data
    ? digest.data.overdue.length +
      digest.data.todaySchedule.length +
      digest.data.staleFollowups.length
    : 0

  return (
    <HomeCard
      title="Today"
      action={<CardLink href="/records?object=schedules">Schedules</CardLink>}
    >
      {date.length === 0 || digest.isPending ? <CardPending label="today’s digest" /> : null}

      {digest.isError ? (
        <CardFailure
          error={digest.error}
          onRetry={() => void digest.refetch()}
          label="Retry loading today’s digest"
        />
      ) : null}

      {digest.isSuccess && total === 0 ? (
        <CardEmpty>Nothing pending. All clear for {digest.data.date}.</CardEmpty>
      ) : null}

      {digest.isSuccess && total > 0 ? (
        <div>
          <ul className="space-y-2">
            {ROWS.map((row) => {
              const count = digest.data[row.key].length
              return (
                <li key={row.key}>
                  <Link
                    href={row.href}
                    className="flex items-center justify-between gap-3 rounded-md px-1 py-0.5 text-sm text-text-secondary transition-colors hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <span>{row.label}</span>
                    <span
                      className={
                        count > 0 ? 'font-mono text-text-primary' : 'font-mono text-text-muted'
                      }
                    >
                      {count}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>

          {digest.data.summary ? (
            <p className="mt-3 line-clamp-3 border-t border-border pt-3 text-xs text-text-muted">
              {digest.data.summary}
            </p>
          ) : null}
        </div>
      ) : null}
    </HomeCard>
  )
}
