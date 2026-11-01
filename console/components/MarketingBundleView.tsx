'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

import { ApiError, describeError, get, post } from '../lib/api'
import type {
  MarketingActionRecord,
  MarketingArtifactRecord,
  MarketingBundleFullResponse,
  MarketingBundleRecord,
  MarketingBundleResponse,
  MarketingBundleWithheldResponse,
  ReviewerPrediction,
  WithheldMarketingBundleRecord,
} from '../lib/types'
import { PageHeader } from './PageHeader'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Skeleton } from './ui/skeleton'


// ── Marketing bundle: the copy, the files, and the two go-live doors ────────
//
// The approval queue shows the staged payload, and the staged payload is
// deliberately identifiers, a hash and numbers (spec §7). That is what makes
// this screen necessary rather than decorative: without it a human approves
// campaign copy they have never read. Reading is all this screen does to the
// bundle. Prepare go-live and the retry control post to the staging routes, which
// queue a decision, and saying yes stays in the queue through
// POST /api/approvals/drafts/:id/decision: there is exactly one way to approve.

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

// ── The files a bundle publishes ────────────────────────────────────────────
//
// The console never imports src/, so the slot registry in src/marketing/site.ts
// is restated here: the two artifact kinds CRUM places at a path, and the
// suffix each one owns. A slot added on the server stops being named on this
// screen until this list grows with it, which is the only drift the duplication
// can cause. The path is built from the bundle's slug, never from the model,
// for the same reason the server guards that slug: a placement instruction an
// agent wrote is not a file name.

const SITE_SLOTS = [
  { kind: 'page_html', suffix: 'index.html' },
  { kind: 'thank_you_html', suffix: 'thanks/index.html' },
] as const

interface SiteFileRow {
  path: string
  sha256: string | null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The slug the last publish used, falling back to the plan's page slug so a
 * bundle that has never been staged still names its files. Both spellings are
 * the phrase the server would publish under; reading it back rather than
 * inventing one keeps the path on screen the path that would be uploaded.
 */
function siteSlug(bundle: MarketingBundleRecord, actions: MarketingActionRecord[]): string | null {
  const published = actions.find((action) => action.action === 'publish_page')
  const fromAction = published ? nonEmptyString(published.payload['slug']) : null
  if (fromAction) return fromAction
  const funnel = bundle.funnelPlan
  if (!funnel || typeof funnel !== 'object') return null
  const page = (funnel as Record<string, unknown>)['page']
  if (!page || typeof page !== 'object') return null
  return nonEmptyString((page as Record<string, unknown>)['slug'])
}

function approvedSiteHashOf(actions: MarketingActionRecord[]): string | null {
  const published = actions.find((action) => action.action === 'publish_page')
  return published ? nonEmptyString(published.payload['siteHash']) : null
}

/**
 * sha256 of one file's bytes, so the owner can compare a row against a copy of
 * the file they or a provider holds. Web Crypto is the only hasher the platform
 * offers a client without a new dependency, and its digest is async, so these
 * rows are built after the fetch rather than during render. A browser without
 * crypto.subtle gets null, which renders as a dash: an empty cell reads as a
 * hash and the aggregate site hash would be a number no file ever had.
 */
async function sha256Hex(text: string): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return null
  }
}

async function siteFiles(
  bundle: MarketingBundleRecord,
  artifacts: MarketingArtifactRecord[],
  actions: MarketingActionRecord[],
): Promise<SiteFileRow[]> {
  const slug = siteSlug(bundle, actions)
  if (slug === null) return []
  const files: SiteFileRow[] = []
  for (const slot of SITE_SLOTS) {
    const artifact = artifacts.find((a) => a.kind === slot.kind && a.textContent !== null)
    if (!artifact) continue
    // The hash beside a path is that file's own digest. The site hash covers
    // the sorted path and hash pairs of the whole site, so showing it per row
    // would tell an owner their file matches a value no provider computed for
    // it. The aggregate is shown once, above the table, as what was signed.
    files.push({
      path: `${slug}/${slot.suffix}`,
      sha256: await sha256Hex(artifact.textContent ?? ''),
    })
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * The action a retry would clone, if any. A retry never mutates the failed row,
 * because the trail keeps both attempts, so a failed row alone is not evidence
 * that a retry is still needed. The candidate is the newest row of its action
 * name, and only while that newest row failed: a later queued, running or
 * succeeded row of the same name means the action has moved on, and another
 * click would queue a duplicate. Actions arrive oldest first, so walking
 * backwards meets the newest row of each name first.
 */
function retryableAction(actions: MarketingActionRecord[]): MarketingActionRecord | null {
  const newestSeen = new Set<string>()
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index]
    if (newestSeen.has(action.action)) continue
    newestSeen.add(action.action)
    if (action.status === 'failed') return action
  }
  return null
}

function urlOf(action: MarketingActionRecord): string | null {
  return action.result ? nonEmptyString(action.result['url']) : null
}

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

/**
 * The one runtime rule that decides which of the two reads arrived.
 *
 * `predictionRequired && !prediction` is the withheld case and nothing else:
 * Task 11's server sends exactly that pair when it has deleted the prose, and a
 * gated bundle whose reviewer has already predicted arrives as the full read
 * with `predictionRequired` still true. The union in lib/types cannot tell those
 * apart by itself, because `predictionRequired: boolean` is compatible with
 * `true`, so the judgement lives here as a named predicate and the REST tests
 * for both shapes (Task 11 Step 1) are what keep it honest.
 */
function isWithheldRead(data: MarketingBundleResponse): data is MarketingBundleWithheldResponse {
  return data.predictionRequired === true && data.prediction === null
}

/**
 * The cognitive forcing gate, as the reviewer meets it (spec section 8.2).
 *
 * The server already withheld the prose; this panel's job is to explain why the
 * page is empty instead of looking broken, and to keep the one field the
 * reviewer has to fill in unambiguous. It stages nothing and decides nothing:
 * approving still goes through the queue, so the only thing a prediction can
 * change is what the reviewer is able to see next.
 */
function PredictionGate({
  bundle,
  value,
  onChange,
  onSubmit,
  busy,
}: {
  bundle: WithheldMarketingBundleRecord
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  busy: boolean
}) {
  return (
    <div className="mt-4">
      <PageHeader
        title={bundle.brief}
        description={OBJECTIVE_LABEL[bundle.objective]}
        actions={<Badge variant={STATUS_VARIANT[bundle.status]}>{bundle.status}</Badge>}
      />
      <p className="mt-3 text-sm text-text-secondary">
        The proposal is hidden until you write down what you expect from it. Reading it first makes
        any decision look informed, so this screen asks for your guess while you still have to make
        one.
      </p>
      <label className="mt-4 block text-sm text-text-secondary" htmlFor="crum-prediction">
        What do you expect this bundle to achieve, and what would tell you it failed?
      </label>
      <textarea
        id="crum-prediction"
        className="focus-ring mt-2 w-full rounded-md border border-border bg-bg-card px-3 py-2 text-sm text-text-primary"
        rows={5}
        maxLength={2000}
        value={value}
        placeholder="Example: about forty assessments a month, and a cost per lead under thirty dollars."
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="mt-1 text-xs text-text-muted">
        Up to 2000 characters. Nothing here approves anything.
      </p>
      <Button
        className="mt-3"
        size="sm"
        variant="default"
        disabled={busy || value.trim() === ''}
        onClick={onSubmit}
      >
        Record my prediction
      </Button>
    </div>
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
      ) : artifact.kind === 'image' && artifact.documentId !== null ? (
        <>
          {/* The browser fetches this through the console's own /api rewrite,
              which stamps the identity headers the REST plane requires
              (console/middleware.ts:22), so an <img> needs no token, no blob
              dance and no client-side fetch. The gate holds even with the URL in
              hand: a gated bundle's read carries no artifacts at all, and
              src/api/marketing.ts answers 409 for the bytes of one (Task 12). */}
          <img
            src={`/api/marketing/assets/${encodeURIComponent(artifact.documentId)}/bytes`}
            alt={`Generated image ${artifact.id.slice(0, 8)}`}
            className="mt-2 max-h-72 w-full rounded-md border border-border object-contain"
            loading="lazy"
          />
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
            .
          </p>
        </>
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
          . This kind has no renderer: the link reads the document's JSON record.
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
  const [actions, setActions] = useState<MarketingActionRecord[]>([])
  const [files, setFiles] = useState<SiteFileRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [staged, setStaged] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [gated, setGated] = useState<WithheldMarketingBundleRecord | null>(null)
  const [predictionText, setPredictionText] = useState('')
  const [predicted, setPredicted] = useState<ReviewerPrediction | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setMissing(false)
    setGated(null)
    setPredicted(null)
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
        setActions([])
        setFiles([])
        setError('The bundle request came back without a bundle in it.')
        return
      }
      if (isWithheldRead(data)) {
        // Render the gate rather than a half-empty bundle. The prose keys are
        // absent, `artifacts` is absent, and a screen that tried to draw both
        // would read as a campaign with nothing in it instead of a campaign the
        // reviewer has not earned yet.
        setGated(data.bundle)
        setBundle(null)
        setArtifacts([])
        setActions([])
        setFiles([])
        return
      }
      const loadedArtifacts = data.artifacts ?? []
      const loadedActions = data.actions ?? []
      setPredicted(data.prediction)
      setBundle(data.bundle)
      setArtifacts(loadedArtifacts)
      setActions(loadedActions)
      setFiles(await siteFiles(data.bundle, loadedArtifacts, loadedActions))
    } catch (err) {
      setBundle(null)
      setArtifacts([])
      setActions([])
      setFiles([])
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

  // Everything the go-live controls draw is derived from the two reads above,
  // never stored twice: a button that outlived the status it was drawn for is
  // how a screen offers a promotion for a bundle that is already live.
  const approvedHash = useMemo(() => approvedSiteHashOf(actions), [actions])

  const canPromote = useMemo(
    () =>
      bundle?.status === 'approved' &&
      actions.some((action) => action.action === 'publish_page' && action.status === 'succeeded') &&
      !actions.some((action) => action.action === 'promote_page'),
    [bundle, actions],
  )

  // The newest attempt of each action name, and a retry only when that attempt
  // failed. The failed row stays in the trail after a retry, so picking any
  // failed row would leave the control on screen forever.
  const retryAction = useMemo(() => retryableAction(actions), [actions])

  // Promotion is the deployment the owner asked for; the preview is the one a
  // publish produced. Only a URL the API recorded is ever linked, because a URL
  // this screen built is an address that does not exist. Republishing and
  // promoting each append a row, so the last match of a name is its newest
  // attempt: a bundle promoted twice must link the deployment that is live now,
  // not the first one that ever answered with a URL.
  const liveAction = useMemo(() => {
    const succeeded = actions.filter(
      (action) => action.status === 'succeeded' && urlOf(action) !== null,
    )
    const newestOf = (name: string): MarketingActionRecord | null => {
      for (let index = succeeded.length - 1; index >= 0; index -= 1) {
        if (succeeded[index].action === name) return succeeded[index]
      }
      return null
    }
    return newestOf('promote_page') ?? newestOf('publish_page')
  }, [actions])
  const liveHref = liveAction ? urlOf(liveAction) : null

  // Both controls reach this one function, so a staging path is spelled once and
  // neither control can grow a body or a decision route of its own. The result
  // is the pending write id, kept in state so the sentence survives the reload.
  async function stage(path: string) {
    setBusy(true)
    setError(null)
    setStaged(null)
    try {
      const result = await post<{ pendingWriteId: string }>(path)
      setStaged(result.pendingWriteId)
      await load()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  async function recordPrediction() {
    if (gated === null) return
    setBusy(true)
    setError(null)
    try {
      await post<{ prediction: ReviewerPrediction; existed: boolean }>(
        `/api/marketing/bundles/${encodeURIComponent(gated.id)}/prediction`,
        { predictedOutcome: predictionText.trim() },
      )
      setPredictionText('')
      // The re-read is the whole refresh: the server now returns the full read,
      // so the prose, the artifacts and the prediction row arrive through the
      // same path that already works rather than a second state machine.
      await load()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

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
      ) : gated ? (
        <PredictionGate
          bundle={gated}
          value={predictionText}
          onChange={setPredictionText}
          onSubmit={() => void recordPrediction()}
          busy={busy}
        />
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
            <Row label="Lead token">
              {bundle.leadToken ? (
                <code className="font-mono break-all text-text-primary">{bundle.leadToken}</code>
              ) : (
                <span className="text-text-muted">Not minted yet.</span>
              )}
            </Row>
            <Row label="Saved">{bundle.createdAt}</Row>
          </dl>
          {predicted ? (
            <p className="mt-3 break-words text-sm text-text-secondary">
              You predicted: <span className="text-text-primary">{predicted.predictedOutcome}</span>{' '}
              <span className="text-text-muted">
                (recorded {predicted.createdAt.slice(0, 10)}, before this page was opened)
              </span>
            </p>
          ) : null}

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

          <section className="mt-8">
            <h2 className="text-lg font-medium text-text-primary">Site files</h2>
            {files.length === 0 ? (
              <p className="mt-2 text-sm text-text-muted">This bundle publishes no files.</p>
            ) : (
              <>
                {approvedHash ? (
                  <p className="mt-2 break-words text-sm text-text-secondary">
                    Site hash the approval signed:{' '}
                    <code className="font-mono text-xs break-all text-text-primary">
                      {approvedHash}
                    </code>
                  </p>
                ) : (
                  <p className="mt-2 text-sm text-text-muted">
                    No approval has signed a site hash for this bundle yet.
                  </p>
                )}
                <div className="mt-2 overflow-x-auto rounded-lg border border-border">
                  <table className="w-full border-collapse text-sm">
                    <caption className="px-3 pt-3 text-left text-xs uppercase tracking-[0.06em] text-text-muted">
                      Files this bundle publishes, and each file's own sha256
                    </caption>
                    <tbody>
                      {files.map((file) => (
                        <tr key={file.path} className="border-t border-border">
                          <td className="px-3 py-2 align-top">
                            <code className="font-mono text-xs text-text-primary">{file.path}</code>
                          </td>
                          <td className="px-3 py-2 align-top">
                            {file.sha256 === null ? (
                              <span
                                className="text-xs text-text-muted"
                                title="This browser cannot compute SHA-256."
                              >
                                —
                              </span>
                            ) : (
                              <code className="font-mono text-xs text-text-muted" title={file.sha256}>
                                {file.sha256.slice(0, 12)}
                              </code>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          {files.length > 0 ? (
            <section className="mt-8">
              <h2 className="text-lg font-medium text-text-primary">Go live</h2>
              <p className="mt-2 text-sm text-text-secondary">
                {bundle.status === 'live'
                  ? 'This bundle is on your domain.'
                  : 'Going live is a second decision: preparing it queues an approval, and the page moves to your domain only after you decide it in the queue.'}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {canPromote ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void stage(`/api/marketing/bundles/${encodeURIComponent(bundleId)}/promote`)
                    }
                  >
                    Prepare go-live
                  </Button>
                ) : null}
                {retryAction ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void stage(
                        `/api/marketing/bundles/${encodeURIComponent(bundleId)}/actions/${encodeURIComponent(retryAction.id)}/retry`,
                      )
                    }
                  >
                    {/* The control clones the failed action, so it is named for
                        that action. A failed promotion is the owner's go-live
                        path, and calling it "Retry publish" would send them
                        looking for a different door. */}
                    {retryAction.action === 'promote_page' ? 'Retry go-live' : 'Retry publish'}
                  </Button>
                ) : null}
                {liveHref ? (
                  <a
                    href={liveHref}
                    target="_blank"
                    rel="noreferrer"
                    className="focus-ring text-sm text-text-secondary underline underline-offset-2"
                  >
                    {liveAction?.action === 'promote_page' ? 'Live site' : 'Preview'}
                  </a>
                ) : null}
              </div>
              {retryAction ? (
                <p className="mt-2 break-words text-sm text-danger">
                  The last {retryAction.action} failed:{' '}
                  <code>{retryAction.lastError ?? 'no error recorded'}</code>
                </p>
              ) : null}
              {staged ? (
                <p className="mt-2 text-sm text-success">
                  Staged for approval <code>{staged}</code>.{' '}
                  <Link href="/approvals" className="focus-ring underline underline-offset-2">
                    Decide it in the queue.
                  </Link>
                </p>
              ) : null}
            </section>
          ) : null}
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
