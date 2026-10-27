'use client'

import { useParams } from 'next/navigation'

import { CustomerDetail } from '@/components/records/CustomerDetail'

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
