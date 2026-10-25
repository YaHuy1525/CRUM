import Link from 'next/link'

import { PageHeader } from '@/components/PageHeader'

/**
 * One conversation. §"Route map": `/chats/[id]` reopens a single saved thread
 * with its full transcript.
 *
 * The plane does not yet project message history to the browser (§10.2), so this
 * shows the real conversation id from the URL — never a fabricated transcript —
 * and states honestly that the messages will render here once history lands. The
 * id is read from `params` (a promise in Next 15 for a server component) and
 * surfaced verbatim, so a deep link resolves to the thread it names.
 */
export default async function ChatDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  return (
    <main className="mx-auto w-full max-w-3xl px-8 py-10">
      <PageHeader
        title="Conversation"
        description={
          <>
            Thread <code className="font-mono text-text-secondary">{id}</code>
          </>
        }
        actions={
          <Link
            href="/chats"
            className="focus-ring inline-flex items-center gap-2 rounded-md border border-border bg-bg-card px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-hover"
          >
            All conversations
          </Link>
        }
      />

      <div
        className="mt-6 rounded-lg border border-dashed border-border-strong bg-bg-card p-12 text-center"
        data-testid="chat-detail-empty"
      >
        <p className="text-sm font-medium text-text-secondary">This transcript is not available yet.</p>
        <p className="mx-auto mt-1 max-w-prose text-sm text-text-muted">
          The messages for this conversation will render here once transcript history is projected
          to the console. Start a live conversation on the{' '}
          <Link href="/" className="text-accent-bright underline-offset-4 hover:underline">
            Home
          </Link>{' '}
          workbench in the meantime.
        </p>
      </div>
    </main>
  )
}
