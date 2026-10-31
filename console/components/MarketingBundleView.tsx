'use client'

import { useCallback, useEffect, useState } from 'react'

import { ApiError, describeError, get } from '../lib/api'
import type {
  MarketingArtifactRecord,
  MarketingBundleRecord,
  MarketingBundleResponse,
} from '../lib/types'
import { PageHeader } from './PageHeader'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Skeleton } from './ui/skeleton'


// ── Marketing bundle: read-only (slice 1) ───────────────────────────────────
//
// The approval queue shows the staged payload, and the staged payload is
// deliberately identifiers, a hash and numbers (spec §7). That is what makes
// this screen necessary rather than decorative: without it a human approves
// campaign copy they have never read. Everything here is display only, because
// saying yes happens in the queue through POST /api/approvals/drafts/:id/decision
// and there must stay exactly one way to approve.

const STATUS_VARIANT: Record<
  MarketingBundleRecord['status'],
  'default' | 'secondary' | 'success' | 'warning' | 'danger'
> = {
  draft: 'secondary',
  staged: 'warning',
  approved: 'success',
  publishing: 'warning',
  live: 'default',
  failed: 'danger',
  archived: 'secondary',
}

const OBJECTIVE_LABEL: Record<MarketingBundleRecord['objective'], string> = {
  outreach_support: 'Support outreach',
  inbound_leads: 'Bring in leads',
  proof_asset: 'Build a proof asset',
}

const SECTIONS: {
  key: 'strategy' | 'copy' | 'mediaPlan' | 'funnelPlan' | 'analysis'
  label: string
}[] = [
  { key: 'strategy', label: 'Strategy' },
  { key: 'copy', label: 'Copy' },
  { key: 'mediaPlan', label: 'Media plan' },
  { key: 'funnelPlan', label: 'Funnel plan' },
  { key: 'analysis', label: 'Analysis' },
]

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-text-secondary">{children}</dd>
    </>
  )
}

/**
 * Plan blocks are jsonb a model wrote, so beyond "json" nothing is guaranteed.
 * Strings render as prose, because hooks and message bodies are what a reviewer
 * reads; structure renders as structure; an absent block says it is absent
 * rather than disappearing, which is how a missing media plan gets noticed.
 */
function Value({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <p className="text-sm text-text-muted">Nothing recorded.</p>
  }
  if (typeof value === 'string') {
    return <p className="mt-1 break-words whitespace-pre-wrap text-sm text-text-secondary">{value}</p>
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <p className="mt-1 text-sm text-text-secondary">{String(value)}</p>
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <p className="text-sm text-text-muted">Empty list.</p>
    return (
      <ul className="mt-1 space-y-2">
        {value.map((entry, index) => (
          <li key={index}>
            <Value value={entry} />
          </li>
        ))}
      </ul>
    )
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return <p className="text-sm text-text-muted">Empty object.</p>
  return (
    <dl className="mt-1 space-y-2">
      {entries.map(([key, nested]) => (
        <div key={key}>
          <dt className="text-xs uppercase tracking-[0.06em] text-text-muted">{key}</dt>
          <dd className="min-w-0">
            <Value value={nested} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Artifact({ artifact }: { artifact: MarketingArtifactRecord }) {
  return (
    <li className="rounded-lg border border-border bg-bg-card p-3">
      <p className="text-xs uppercase tracking-[0.06em] text-text-muted">
        {artifact.role} · {artifact.kind} · {artifact.status}
      </p>
      {artifact.textContent !== null ? (
        <p className="mt-2 break-words whitespace-pre-wrap text-sm text-text-secondary">
          {artifact.textContent}
        </p>
      ) : artifact.documentId !== null ? (
        <p className="mt-2 text-sm text-text-secondary">
          Stored as document{' '}
          <a
            className="focus-ring underline underline-offset-2"
            href={`/api/documents/${encodeURIComponent(artifact.documentId)}`}
            target="_blank"
            rel="noreferrer"
          >
            {artifact.documentId.slice(0, 8)}
          </a>
          . Slice 1 renders no image: this link reads the document's JSON record,
          and nothing in the plane serves the stored bytes yet.
        </p>
      ) : (
        <p className="mt-2 text-sm text-text-muted">No content recorded.</p>
      )}
    </li>
  )
}

export interface MarketingBundleViewProps {
  bundleId: string
}

export function MarketingBundleView({ bundleId }: MarketingBundleViewProps) {
  const [bundle, setBundle] = useState<MarketingBundleRecord | null>(null)
  const [artifacts, setArtifacts] = useState<MarketingArtifactRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setMissing(false)
    try {
      const data = await get<MarketingBundleResponse>(
        `/api/marketing/bundles/${encodeURIComponent(bundleId)}`,
      )
      // A 200 is not the same thing as a readable bundle. The console never
      // imports src/, so a renamed envelope key is drift this screen can only
      // notice at runtime — and an empty div would read as an empty bundle rather
      // than as the two halves of the product disagreeing.
      if (!data || typeof data !== 'object' || !data.bundle) {
        setBundle(null)
        setArtifacts([])
        setError('The bundle request came back without a bundle in it.')
        return
      }
      setBundle(data.bundle)
      setArtifacts(data.artifacts ?? [])
    } catch (err) {
      setBundle(null)
      setArtifacts([])
      if (err instanceof ApiError && (err.status === 404 || err.status === 400)) {
        setMissing(true)
      } else {
        setError(describeError(err))
      }
    } finally {
      setLoading(false)
    }
  }, [bundleId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="mt-4">
      {loading ? (
        <div className="space-y-3" data-testid="bundle-loading">
          <p className="sr-only" role="status">
            Loading bundle
          </p>
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
        </div>
      ) : missing ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          Bundle not found.
        </div>
      ) : error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
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
      ) : bundle ? (
        <>
          <PageHeader
            title={bundle.brief}
            description={
              <>
                {OBJECTIVE_LABEL[bundle.objective]}
                {bundle.audienceNote ? ` · ${bundle.audienceNote}` : ''}
              </>
            }
            actions={<Badge variant={STATUS_VARIANT[bundle.status]}>{bundle.status}</Badge>}
          />

          <dl className="mt-4 grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1 text-sm">
            <Row label="Content hash">
              <code className="font-mono break-all text-text-primary">{bundle.draftHash.slice(0, 16)}</code>
            </Row>
            <Row label="Prompt version">{bundle.promptVersion}</Row>
            <Row label="Bundle id">
              <code className="font-mono break-all text-text-primary">{bundle.id}</code>
            </Row>
            <Row label="Saved">{bundle.createdAt}</Row>
          </dl>

          {SECTIONS.map((section) => (
            <section key={section.key} className="mt-8">
              <h2 className="text-lg font-medium text-text-primary">{section.label}</h2>
              <Value value={bundle[section.key]} />
            </section>
          ))}

          <section className="mt-8">
            <h2 className="text-lg font-medium text-text-primary">Assets</h2>
            {artifacts.length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">No assets in this bundle.</p>
            ) : (
              <ul className="mt-2 space-y-3">
                {artifacts.map((artifact) => (
                  <Artifact key={artifact.id} artifact={artifact} />
                ))}
              </ul>
            )}
          </section>
        </>
      ) : (
        <div
          role="alert"
          className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          Nothing in this response can be shown as a bundle.
        </div>
      )}
    </div>
  )
}
