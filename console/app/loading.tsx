import { Skeleton } from '@/components/ui/skeleton'

/**
 * Route-level loading surface. §"Design system foundation" (Cedar's product loads
 * with pulse skeletons, not spinners or dashes).
 *
 * Shaped like a real page — a header row plus a content column — so the swap from
 * skeleton to content does not jump the layout. Built from the `Skeleton`
 * primitive, which pulses on `bg-bg-raised`; no fabricated data, just the reading
 * state. Kept server-safe (no hooks) so any segment can suspend into it.
 */
export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-3xl px-8 py-10" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>

      <div className="mt-6 space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-2/3" />
      </div>
    </main>
  )
}
