'use client'

import { useParams } from 'next/navigation'
import Link from 'next/link'

import { MarketingBundleView } from '@/components/MarketingBundleView'


// ── Marketing bundle: read-only route (slice 1) ─────────────────────────────
//
// Reached from the approval queue, and from nowhere else in slice 1: there is
// no bundle list, because there is no `marketing.list_bundles` tool and the
// screen exists to make one approval decidable, not to browse history.

export default function MarketingBundlePage() {
  const params = useParams<{ id: string }>()
  const id = typeof params?.id === 'string' ? params.id : null

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-10">
      <Link
        href="/governance"
        className="focus-ring text-sm text-text-secondary underline-offset-2 hover:underline"
      >
        Back to approvals
      </Link>

      {id ? (
        <MarketingBundleView bundleId={id} />
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          No bundle id in this address.
        </div>
      )}
    </main>
  )
}
