'use client'

import { useEffect, useState } from 'react'

import { PageHeader } from '@/components/PageHeader'
import { AwaitingDecisionCard } from '@/components/home/AwaitingDecisionCard'
import { QuickLauncher } from '@/components/home/QuickLauncher'
import { RecentConversationsCard } from '@/components/home/RecentConversationsCard'
import { TodayCard } from '@/components/home/TodayCard'

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
