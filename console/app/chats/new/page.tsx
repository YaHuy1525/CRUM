import Link from 'next/link'

import { PageHeader } from '@/components/PageHeader'

/**
 * New chat. §"Route map": `/chats/new` is the prominent entry into a dedicated
 * conversation surface.
 *
 * The standalone composer is built out in a later phase. Rather than render a
 * dead input or a "coming soon" internal note, this points at the chat that
 * already works today — the Home workbench — so the action the sidebar promises
 * always lands somewhere real. No fabricated transcript, no fake data.
 */
export default function NewChatPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-8 py-10">
      <PageHeader
        title="New chat"
        description="Start a conversation with the CRUM assistant."
      />

      <div
        className="mt-6 rounded-lg border border-dashed border-border-strong bg-bg-card p-12 text-center"
        data-testid="chats-new-empty"
      >
        <p className="text-sm font-medium text-text-secondary">
          The dedicated chat surface is on its way.
        </p>
        <p className="mx-auto mt-1 max-w-prose text-sm text-text-muted">
          You can start a conversation right now on the{' '}
          <Link href="/" className="text-accent-bright underline-offset-4 hover:underline">
            Home
          </Link>{' '}
          workbench, where the live assistant, its transcript, and the context rail already work.
          Conversations you start will be reopenable here once this surface lands.
        </p>
        <Link
          href="/"
          className="focus-ring mt-5 inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg shadow-accent transition-colors hover:bg-accent/90"
        >
          Go to the Home workbench
        </Link>
      </div>
    </main>
  )
}
