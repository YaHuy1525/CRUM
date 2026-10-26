import Link from 'next/link'

import { PageHeader } from '@/components/PageHeader'
import { RecordsBrowser } from '@/components/records/RecordsBrowser'
import { isRecordObject } from '@/lib/records'

export default async function RecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ object?: string }>
}) {
  const { object } = await searchParams
  const initialObject = isRecordObject(object) ? object : 'customers'

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-10">
      <PageHeader
        title="Records"
        description="CRM objects you can read, capture, and route through the approval queue."
        actions={
          <Link
            href="/records/new"
            className="focus-ring inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-accent-fg shadow-accent transition-colors hover:bg-accent/90"
          >
            New from text
          </Link>
        }
      />

      <RecordsBrowser initialObject={initialObject} />
    </main>
  )
}
