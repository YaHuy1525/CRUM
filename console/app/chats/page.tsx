import Link from 'next/link'

import { PageHeader } from '@/components/PageHeader'

/**
 * Chats index. §"Route map": `/chats` is the searchable history of saved
 * conversations. The list itself is wired to the conversation-history endpoint in
 * a later phase, so this renders an honest empty state — no fabricated rows, no
 * "coming in phase N" internal copy. The live chat that already works today stays
 * reachable from Home, and this page says so rather than pretending to be it.
 */
export default function ChatsIndexPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-8 py-10">
      <PageHeader
        title="Conversations"
        description="Your saved conversations, searchable and reopenable with their full transcript."
        actions={
          <Link
            href="/chats/new"
            className="focus-ring inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg shadow-accent transition-colors hover:bg-accent/90"
          >
            New chat
          </Link>
        }
      />

      <div
        className="mt-6 rounded-lg border border-dashed border-border-strong bg-bg-card p-12 text-center"
        data-testid="chats-empty"
      >
        <p className="text-sm font-medium text-text-secondary">No conversations yet.</p>
        <p className="mx-auto mt-1 max-w-prose text-sm text-text-muted">
          Conversations you start will appear here. The live chat is currently on the{' '}
          <Link href="/" className="text-accent-bright underline-offset-4 hover:underline">
            Home
          </Link>{' '}
          workbench.
        </p>
      </div>
    </main>
  )
}
