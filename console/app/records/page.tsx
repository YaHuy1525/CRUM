import Link from 'next/link'

import { PageHeader } from '@/components/PageHeader'
import { RecordsBrowser } from '@/components/records/RecordsBrowser'
import { isRecordObject } from '@/lib/records'

/**
 * Records index. §"Route map": `/records` is the browsable home for CRM objects,
 * with five sub-tabs backed by the read-only list endpoints in `src/api/crm.ts`.
 *
 * The tab comes from `?object=` and is validated here rather than in the client:
 * a hand-typed link like `/records?object=tasks` is a legitimate way in (the Home
 * today card uses it), and an unknown value should land on Customers instead of
 * rendering an empty panel. Reading `searchParams` on the server also keeps
 * `useSearchParams` — and the Suspense boundary it demands — out of the browser
 * component entirely.
 *
 * The key list comes from `lib/records.ts`, not from the browser component. That
 * component is `'use client'`, so a value imported from it arrives here as a
 * client reference and every call on it throws at request time. Only the type
 * may cross that boundary.
 *
 * There is no write action on this page. Creating a record means the assistant
 * stages a draft and the approval queue commits it, so the only "new" affordance
 * is the capture flow, which hands its parsed text to a chat.
 */
export default async function RecordsPage({
  searchParams,
}: {
  searchParams: Promise<{ object?: string }>
}) {
  const { object } = await searchParams
  const initialObject = isRecordObject(object) ? object : 'customers'

  return (
    <main className="mx-auto w-full max-w-5xl px-8 py-10">
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
