import Link from 'next/link'

import { PageHeader } from '@/components/PageHeader'
import { LaunchView } from '@/components/chats/LaunchView'


const MAX_PROMPT = 4000

export default async function NewChatPage({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string | string[] }>
}) {
  const { prompt } = await searchParams
  const initialText = typeof prompt === 'string' ? prompt.slice(0, MAX_PROMPT) : ''

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 md:px-8 md:py-10">
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

      <LaunchView initialText={initialText} />
    </main>
  )
}
