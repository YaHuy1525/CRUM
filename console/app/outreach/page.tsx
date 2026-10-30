'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

import { describeError, get } from '@/lib/api'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'


// ── Prospects: read-only list (Task 12) ────────────────────────────────────
//
// Everything is fetched same-origin through /api/prospects, so the Next rewrite
// forwards it to the REST plane and middleware.ts stamps the identity headers.
// The browser never talks to :4113 directly and holds no credential.

interface ProspectItem {
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
}

interface MergeCandidateSide {
  id: string
  name: string
  country: string
  score: number | null
}

interface MergeCandidate {
  id: string
  reason: string
  similarity: number
  left: MergeCandidateSide
  right: MergeCandidateSide
}

const PAGE_SIZE = 50

const COUNTRY_TABS = [
  { value: null, label: 'All' },
  { value: 'AU', label: 'Australia' },
  { value: 'VN', label: 'Vietnam' },
] as const

const TAB_BASE =
  'focus-ring rounded-md border px-2.5 py-1 text-sm transition-colors hover:no-underline'
const TAB_IDLE = 'border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary'
const TAB_ACTIVE = 'border-accent-line bg-accent-soft font-semibold text-accent-bright'

function asCountry(raw: string | null): 'AU' | 'VN' | undefined {
  return raw === 'AU' || raw === 'VN' ? raw : undefined
}

function formatCount(value: number | null): string {
  return value === null ? '-' : new Intl.NumberFormat('en-AU').format(value)
}

async function loadProspects(
  country: 'AU' | 'VN' | undefined,
  offset: number,
): Promise<ProspectItem[]> {
  const search = new URLSearchParams()
  if (country) search.set('country', country)
  search.set('limit', String(PAGE_SIZE))
  search.set('offset', String(offset))
  const body = await get<{ items: ProspectItem[] }>(`/api/prospects?${search.toString()}`)
  return body.items
}

function MergeCandidates() {
  const [items, setItems] = useState<MergeCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const body = await get<{ items: MergeCandidate[] }>('/api/prospects/merge-candidates')
      setItems(body.items)
    } catch (err) {
      setError(describeError(err))
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section
      aria-labelledby="merge-candidates-heading"
      className="mt-4 rounded-lg border border-border bg-bg-card"
    >
      <div className="border-b border-border px-3 py-2">
        <h2 id="merge-candidates-heading" className="text-sm font-semibold text-text-primary">
          Possible duplicates
        </h2>
        <p className="mt-0.5 text-xs text-text-muted">
          Pairs the import flagged by name. Review only: resolving a pair needs the
          merge tool, so nothing here merges or dismisses.
        </p>
      </div>

      {loading ? (
        <div className="space-y-2 p-3" data-testid="merge-candidates-loading">
          <p className="sr-only" role="status">
            Loading merge candidates
          </p>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-4/5" />
        </div>
      ) : error ? (
        <div
          role="alert"
          className="m-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
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
      ) : items.length === 0 ? (
        <p className="px-3 py-3 text-sm text-text-muted">No duplicate pairs pending.</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((candidate) => (
            <li key={candidate.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <Link
                className="focus-ring font-medium text-text-primary underline-offset-2 hover:underline"
                href={`/outreach/${candidate.left.id}`}
              >
                {candidate.left.name}
              </Link>
              <span className="text-xs text-text-muted">{candidate.left.country}</span>
              <span className="text-xs tabular-nums text-text-secondary">
                {candidate.left.score ?? 'unscored'}
              </span>
              <span aria-hidden="true" className="text-text-muted">
                /
              </span>
              <Link
                className="focus-ring font-medium text-text-primary underline-offset-2 hover:underline"
                href={`/outreach/${candidate.right.id}`}
              >
                {candidate.right.name}
              </Link>
              <span className="text-xs text-text-muted">{candidate.right.country}</span>
              <span className="text-xs tabular-nums text-text-secondary">
                {candidate.right.score ?? 'unscored'}
              </span>
              <span className="ml-auto text-xs text-text-muted">
                {candidate.reason} · {Math.round(candidate.similarity * 100)}% match
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ProspectList() {
  const searchParams = useSearchParams()
  const country = asCountry(searchParams.get('country'))

  const [items, setItems] = useState<ProspectItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (offset: number) => {
      if (offset === 0) setLoading(true)
      else setLoadingMore(true)
      setError(null)
      try {
        const next = await loadProspects(country, offset)
        setItems((prev) => (offset === 0 ? next : [...prev, ...next]))
      } catch (err) {
        setError(describeError(err))
        if (offset === 0) setItems([])
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [country],
  )

  useEffect(() => {
    void load(0)
  }, [load])

  return (
    <>
      <PageHeader
        title="Prospects"
        description="Scored micro-audience businesses, their channels, and the drafts staged for outreach. Read-only."
        actions={
          <nav aria-label="Prospect country" className="flex items-center gap-2">
            {COUNTRY_TABS.map((tab) => {
              const active = country === (tab.value ?? undefined)
              return (
                <Link
                  key={tab.label}
                  href={tab.value ? `/outreach?country=${tab.value}` : '/outreach'}
                  aria-current={active ? 'page' : undefined}
                  className={cn(TAB_BASE, active ? TAB_ACTIVE : TAB_IDLE)}
                >
                  {tab.label}
                </Link>
              )
            })}
          </nav>
        }
      />

      <MergeCandidates />

      {loading ? (
        <div className="mt-4 space-y-2" data-testid="outreach-loading">
          <p className="sr-only" role="status">
            Loading prospects
          </p>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-5/6" />
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
            onClick={() => void load(0)}
            className="shrink-0 text-danger hover:bg-danger-soft hover:text-danger"
          >
            Retry
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          No prospects yet. Import a CSV with{' '}
          <code className="font-mono text-xs">npm run prospects:import</code>.
        </div>
      ) : (
        <div className="mt-4">
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-[0.06em] text-text-muted">
                  <th scope="col" className="px-3 py-2 font-medium">Score</th>
                  <th scope="col" className="px-3 py-2 font-medium">Name</th>
                  <th scope="col" className="px-3 py-2 font-medium">Country</th>
                  <th scope="col" className="px-3 py-2 font-medium">Category</th>
                  <th scope="col" className="px-3 py-2 font-medium">Audience</th>
                  <th scope="col" className="px-3 py-2 font-medium">Channels</th>
                  <th scope="col" className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((prospect) => (
                  <tr
                    key={prospect.id}
                    className="border-b border-border last:border-0 hover:bg-bg-hover"
                  >
                    <td className="px-3 py-2 align-top tabular-nums text-text-secondary">
                      {prospect.total ?? 'unscored'}
                      {prospect.band ? (
                        <span className="ml-2 text-xs text-text-muted">{prospect.band}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Link
                        className="focus-ring font-medium text-text-primary underline-offset-2 hover:underline"
                        href={`/outreach/${prospect.id}`}
                      >
                        {prospect.name}
                      </Link>
                      {prospect.city ? (
                        <p className="text-xs text-text-muted">{prospect.city}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 align-top text-text-secondary">{prospect.country}</td>
                    <td className="px-3 py-2 align-top text-text-secondary">
                      {prospect.category ?? '-'}
                    </td>
                    <td className="px-3 py-2 align-top tabular-nums text-text-secondary">
                      {formatCount(prospect.audience)}
                    </td>
                    <td className="px-3 py-2 align-top text-text-secondary">
                      {prospect.platforms.length > 0 ? prospect.platforms.join(', ') : '-'}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Badge variant="secondary">{prospect.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-text-muted">
              Showing {items.length} prospect{items.length === 1 ? '' : 's'}
            </p>
            {items.length === PAGE_SIZE ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void load(items.length)}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </>
  )
}

export default function OutreachPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 md:px-8 md:py-10">
      <Suspense
        fallback={<p className="mt-6 text-sm text-text-muted">Loading prospects…</p>}
      >
        <ProspectList />
      </Suspense>
    </main>
  )
}
