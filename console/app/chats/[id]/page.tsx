import { ConversationView } from '@/components/chats/ConversationView'
import { ContextPanel } from '@/components/chats/ContextPanel'
import { ThreadHeader } from '@/components/chats/ThreadHeader'

export default async function ChatDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  return (
    <main className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 py-6 md:px-8 md:py-8">
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
