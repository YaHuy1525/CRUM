import Link from 'next/link'

import { PageHeader } from '@/components/PageHeader'

/**
 * Records index. §"Route map": `/records` is the browsable home for CRM objects.
 *
 * The searchable object list is wired to the records endpoints in a later phase,
 * so this renders an honest empty state rather than fabricated rows. The capture
 * flow that already works today — `/records/new`, the paste-to-prefill form — is
 * surfaced as the primary action, and a deep link to any single record resolves
 * at `/records/customers/[id]`. Nothing here invents data.
 */
export default function RecordsIndexPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-8 py-10">
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

      <div
        className="mt-6 rounded-lg border border-dashed border-border-strong bg-bg-card p-12 text-center"
        data-testid="records-empty"
      >
        <p className="text-sm font-medium text-text-secondary">No records to browse yet.</p>
        <p className="mx-auto mt-1 max-w-prose text-sm text-text-muted">
          The searchable object list lands here soon. In the meantime, capture a record from pasted
          text with{' '}
          <Link
            href="/records/new"
            className="text-accent-bright underline-offset-4 hover:underline"
          >
            New from text
          </Link>
          , or open a specific customer by its id at{' '}
          <code className="rounded bg-bg-raised px-1.5 py-0.5 font-mono text-xs text-text-secondary">
            /records/customers/&lt;id&gt;
          </code>
          .
        </p>
      </div>
    </main>
  )
}
