import Link from 'next/link'

import { PageHeader } from '@/components/PageHeader'
import { LaunchView } from '@/components/chats/LaunchView'

/**
 * New chat. §"Route map": `/chats/new` is the launch view — a centered composer
 * carrying the one reserved prompt gradient, plus the curated starter cards.
 *
 * Sending here does not stream: it mints the thread id, parks the first message
 * in `sessionStorage`, and navigates to `/chats/[id]`, where the single
 * conversation surface sends it. That keeps one transport for the whole section.
 */
export default function NewChatPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-8 py-10">
      <PageHeader
        title="New chat"
        description="Start a conversation with the CRUM assistant."
        actions={
          <Link
            href="/chats"
            className="focus-ring inline-flex items-center gap-2 rounded-md border border-border bg-bg-card px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover"
          >
            All conversations
          </Link>
        }
      />

      <LaunchView />
    </main>
  )
}
