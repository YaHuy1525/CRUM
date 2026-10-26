'use client'

import { useParams } from 'next/navigation'

import { CustomerDetail } from '@/components/records/CustomerDetail'

/**
 * Deep link to one CRM object. §"Route map": "/records/customers/[id], Customer
 * detail with related contacts, follow-ups, and tasks beneath."
 *
 * The route parameter is read with `useParams()` rather than the page props'
 * `params` because this is a client component: Next 15 hands `params` to a server
 * component as a promise, and awaiting it here would mean the data fetch — which
 * has to happen in the browser, since the identity headers are attached by the
 * middleware on the proxied request — could not be the same component's job.
 *
 * The page itself holds no data logic: `CustomerDetail` reads the plane and owns
 * the loading, error, and not-found states. Splitting it that way lets the
 * related lists below the header share the same table the browser uses.
 */
export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>()
  const id = typeof params?.id === 'string' ? params.id : null

  if (!id) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-10">
        <p className="text-sm text-text-muted">No customer id in this URL.</p>
      </main>
    )
  }

  return <CustomerDetail customerId={id} />
}
