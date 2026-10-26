import Link from 'next/link'

import { PageHeader } from '@/components/PageHeader'
import { ConversationList } from '@/components/chats/ConversationList'

/**
 * Chats index. §"Route map": `/chats` is the searchable history of saved
 * conversations. The list itself is the client component (`ConversationList`),
 * because searching, renaming and deleting are all mutations against the
 * conversation plane; this page stays a server component so the header and the
 * route shell are rendered without waiting for the browser.
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

      <ConversationList />
    </main>
  )
}
