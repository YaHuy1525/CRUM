import { ConversationView } from '@/components/chats/ConversationView'
import { ContextPanel } from '@/components/chats/ContextPanel'
import { ThreadHeader } from '@/components/chats/ThreadHeader'

/**
 * One conversation. §"Route map": `/chats/[id]` reopens a single thread — the
 * stored transcript hydrates first, live streaming continues in place, the title
 * is renameable inline, and the customer context bind lives in a side panel that
 * used to be a Home rail card.
 *
 * The page is a server component only for `params`: every piece below is a client
 * component, because each one reads or mutates the conversation plane. The id is
 * passed down rather than re-read, so all four surfaces agree on one conversation
 * for the life of the route.
 *
 * A missing thread — or one belonging to another user — is handled inside
 * `ConversationView` by raising not-found, so a deep link to someone else's id
 * renders the not-found boundary instead of an empty conversation.
 */
export default async function ChatDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  return (
    <main className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-8 py-8">
      <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="flex min-h-[60vh] min-w-0 flex-col rounded-lg border border-border bg-bg-card p-5">
          <ThreadHeader threadId={id} />
          <ConversationView threadId={id} />
        </section>

        <aside className="min-w-0">
          <ContextPanel threadId={id} />
        </aside>
      </div>
    </main>
  )
}
