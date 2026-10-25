'use client'

import { useParams } from 'next/navigation'
import Link from 'next/link'
import { CustomerPanel } from '@/components/ObjectPanel'

/**
 * Deep link to one CRM object. §4.2.
 *
 * The route parameter is read with `useParams()` rather than the page props'
 * `params` because this is a client component: Next 15 hands `params` to a server
 * component as a promise, and awaiting it here would mean the data fetch — which
 * has to happen in the browser, since the identity headers are attached by the
 * middleware on the proxied request — could not be the same component's job.
 *
 * It shows the record and nothing else: no edit form. Every mutation in this
 * product goes through the agent's staging plus the approval queue, and a second
 * write path that skipped both would be a governance hole dressed as a convenience.
 */
export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>()
  const id = typeof params?.id === 'string' ? params.id : null

  return (
    <main className="console-page">
      <h1>Customer</h1>
      <p className="lede">
        Read through the same visibility rule the agent's own <code>crm.get_customer</code> tool uses.
      </p>

      {id ? (
        <CustomerPanel customerId={id} />
      ) : (
        <p className="hint">No customer id in this URL.</p>
      )}

      <p className="hint" style={{ marginTop: 16 }}>
        To change this record, ask the assistant in the <Link href="/">chat</Link> and approve the
        staged draft under <Link href="/approvals">approvals</Link>.
      </p>
    </main>
  )
}
