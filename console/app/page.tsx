'use client'

import { useEffect, useState } from 'react'

import { PageHeader } from '@/components/PageHeader'
import { AwaitingDecisionCard } from '@/components/home/AwaitingDecisionCard'
import { QuickLauncher } from '@/components/home/QuickLauncher'
import { RecentConversationsCard } from '@/components/home/RecentConversationsCard'
import { TodayCard } from '@/components/home/TodayCard'

/**
 * The dashboard of pointers. §"Route map": `/` is "Home dashboard. Greeting
 * header, awaiting decision card, today digest card, recent conversations card,
 * quick launcher row. No composer, no transcript, no session column, no context
 * bind form."
 *
 * Everything the old Home did has a home of its own now, and each one is a route
 * rather than a pane:
 *
 * - composing or reading a transcript: `/chats/new` and `/chats/[id]`, where
 *   hydration and the single `useChat` transport live;
 * - the thread column: `/chats`, so a conversation link lands on the conversation;
 * - the context bind: the side panel on `/chats/[id]`, which is the only surface
 *   that owns a bound customer;
 * - the digest and the queue: the two cards below, each reading the same endpoint
 *   as the page it points at.
 *
 * The page holds no data logic of its own. Each card owns one read, its own
 * loading, error, and empty state, and its own test, which is what makes "the
 * dashboard is wrong" a five-minute question instead of a whole-page debug.
 *
 * The greeting date is computed after mount so server and client cannot render
 * different days into the same HTML and trip hydration.
 */

export default function HomePage() {
  const [dateLine, setDateLine] = useState('')

  useEffect(() => {
    setDateLine(
      new Date().toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }),
    )
  }, [])

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-10">
      <PageHeader
        title="Welcome back."
        description={dateLine || 'Your workbench at a glance.'}
      />

      <div className="mt-6 grid items-start gap-4 md:grid-cols-3">
        <AwaitingDecisionCard />
        <TodayCard />
        <RecentConversationsCard />
      </div>

      <QuickLauncher />
    </main>
  )
}
