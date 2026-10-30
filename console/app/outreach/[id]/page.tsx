'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'

import { ApiError, describeError, get } from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'


// ── Prospect detail: read-only (Task 12) ───────────────────────────────────
//
// Same-origin fetch through /api/prospects/:id, so the rewrite and middleware.ts
// hand it to the REST plane with an identity attached. Nothing here writes:
// channels, the latest snapshot, and staged drafts are all display-only.

interface ProspectChannel {
  id: string
  platform: string
  handle: string
  profileUrl: string
  audienceCount: number | null
  audienceBasis: string
  audienceConfidence: string
}

interface ProspectSnapshot {
  id: string
  whatTheySell: string | null
  priceMinMinor: number | null
  priceMaxMinor: number | null
  currency: string | null
  weaknessSignals: string[]
  sourceUrl: string | null
  fetchedAt: string
}

interface ProspectDraft {
  id: string
  stage: string
  status: string
  body: string
  language: string
}

interface ProspectDetail {
  id: string
  name: string
  country: string
  category: string | null
  city: string | null
  status: string
  total: number | null
  band: string | null
  platforms: string[]
  audience: number | null
  channels: ProspectChannel[]
  snapshot: ProspectSnapshot | null
  drafts: ProspectDraft[]
}

function formatCount(value: number | null): string {
  return value === null ? 'no count' : new Intl.NumberFormat('en-AU').format(value)
}

function formatPrice(value: number | null, currency: string | null): string | null {
  if (value === null) return null
  return `${(value / 100).toFixed(2)}${currency ? ` ${currency}` : ''}`
}

function priceLabel(snapshot: ProspectSnapshot): string | null {
  const min = formatPrice(snapshot.priceMinMinor, snapshot.currency)
  const max = formatPrice(snapshot.priceMaxMinor, snapshot.currency)
  if (!min && !max) return null
  if (!min) return max
  if (!max || min === max) return min
  return `${min} – ${max}`
}

function SnapshotBody({ snapshot }: { snapshot: ProspectSnapshot }) {
  const price = priceLabel(snapshot)
  return (
    <div className="mt-2 space-y-1 text-sm text-text-secondary">
      <p>{snapshot.whatTheySell ?? 'No offer recorded'}</p>
      <p className="text-text-muted">
        Gaps: {snapshot.weaknessSignals.join(', ') || 'none recorded'}
      </p>
      <p className="text-text-muted">
        Source:{' '}
        {snapshot.sourceUrl ? (
          <a
            className="focus-ring underline underline-offset-2"
            href={snapshot.sourceUrl}
            target="_blank"
            rel="noreferrer"
          >
            {snapshot.sourceUrl}
          </a>
        ) : (
          'unknown'
        )}{' '}
        · {snapshot.fetchedAt}
      </p>
      {price ? <p className="text-text-muted">Price: {price}</p> : null}
    </div>
  )
}

export default function ProspectPage() {
  const params = useParams<{ id: string }>()
  const id = typeof params?.id === 'string' ? params.id : null

  const [prospect, setProspect] = useState<ProspectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  const load = useCallback(async () => {
    if (!id) {
      setMissing(true)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    setMissing(false)
    try {
      setProspect(await get<ProspectDetail>(`/api/prospects/${encodeURIComponent(id)}`))
    } catch (err) {
      setProspect(null)
      if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
        setMissing(true)
      } else {
        setError(describeError(err))
      }
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-10">
      <Link
        href="/outreach"
        className="focus-ring text-sm text-text-secondary underline-offset-2 hover:underline"
      >
        Back to prospects
      </Link>

      {loading ? (
        <div className="mt-4 space-y-3" data-testid="prospect-loading">
          <p className="sr-only" role="status">
            Loading prospect
          </p>
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      ) : missing ? (
        <div className="mt-4 rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          Prospect not found.
        </div>
      ) : error ? (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          <span className="break-words">{error}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            className="shrink-0 text-danger hover:bg-danger-soft hover:text-danger"
          >
            Retry
          </Button>
        </div>
      ) : prospect ? (
        <>
          <PageHeader
            className="mt-4"
            title={prospect.name}
            description={
              <>
                {prospect.country}
                {prospect.city ? ` · ${prospect.city}` : ''} ·{' '}
                {prospect.category ?? 'uncategorised'} · score {prospect.total ?? 'unscored'}
                {prospect.band ? ` (${prospect.band})` : ''}
              </>
            }
            actions={<Badge variant="secondary">{prospect.status}</Badge>}
          />

          <section className="mt-8">
            <h2 className="text-lg font-medium text-text-primary">Channels</h2>
            {prospect.channels.length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">No channels recorded yet.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {prospect.channels.map((channel) => (
                  <li key={channel.id} className="text-text-secondary">
                    <a
                      className="focus-ring underline underline-offset-2"
                      href={channel.profileUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {channel.platform} {channel.handle}
                    </a>
                    <span className="text-text-muted">
                      {' '}
                      {formatCount(channel.audienceCount)} {channel.audienceBasis} (
                      {channel.audienceConfidence})
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mt-8">
            <h2 className="text-lg font-medium text-text-primary">Evidence</h2>
            {prospect.snapshot === null ? (
              <p className="mt-2 text-sm text-text-muted">
                No snapshot yet. Run the enrichment workflow.
              </p>
            ) : (
              <SnapshotBody snapshot={prospect.snapshot} />
            )}
          </section>

          <section className="mt-8">
            <h2 className="text-lg font-medium text-text-primary">Drafts</h2>
            {prospect.drafts.length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">No drafts yet.</p>
            ) : (
              <ul className="mt-2 space-y-4 text-sm">
                {prospect.drafts.map((draft) => (
                  <li key={draft.id} className="rounded-lg border border-border bg-bg-card p-3">
                    <p className="text-xs uppercase tracking-[0.06em] text-text-muted">
                      {draft.stage} · {draft.language} · {draft.status}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-text-secondary">{draft.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </main>
  )
}
