// console/components/AssetManager.tsx
/**
 * Where the paid-for renders are browsable.
 *
 * A generated image is a `marketing_asset` document, which slice 4 decided and
 * slice 5 makes visible: this tab names the kind the list route filters on and
 * shows what one run cost the owner, beside the review flip that lets it be
 * staged at all. There is no upload control here on purpose. An intake door for
 * images would let a picture nobody generated through the paid lane reach a
 * bundle, and the whole asset lane exists so that the thing reviewed is the
 * thing bought.
 *
 * Thumbnails come from `/api/marketing/assets/:id/bytes`, the same gated read the
 * bundle screen uses, not from a browse-only route. A reviewer who can peek at the
 * picture in a second tab has not been forced to predict anything, and the gate
 * would be theatre. So a gated asset renders its placeholder here exactly as it
 * withholds its prose there, and an owner who wants to browse freely browses the
 * assets whose bundles are already decided.
 */
'use client'

import { useCallback, useEffect, useState } from 'react'

import { describeError, get, post } from '../lib/api'
import type { CrmDocument } from '../lib/types'
import { Badge } from './ui/badge'
import { Button } from './ui/button'

type Notice = { kind: 'ok' | 'bad' | 'info'; text: string }

interface ListResponse {
  documents: CrmDocument[]
  total: number
}

interface ReviewResponse {
  documentId: string
  status: string
  invalidatedBundles: number
}

function statusVariant(status: CrmDocument['status']): 'success' | 'warning' | 'danger' {
  if (status === 'ready') return 'success'
  if (status === 'failed') return 'danger'
  return 'warning'
}

/**
 * The `<img>` needs no token: `console/middleware.ts:12` stamps the identity
 * headers on every /api rewrite, which is the same reason
 * `MarketingBundleView.tsx:324` can render a picture inline. The browser cannot
 * tell us which status it got back, so a failed load is answered with the
 * awaiting-review slot rather than a diagnosis. That is the honest shape: the
 * route withholds for a gated bundle, and this component knows only that the
 * bytes did not arrive.
 */
function Thumbnail({ id, title }: { id: string; title: string }) {
  const [blocked, setBlocked] = useState(false)
  if (blocked) {
    return (
      <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-border-strong bg-bg-raised px-1 text-center text-[10px] leading-tight text-text-muted">
        Awaiting review
      </div>
    )
  }
  return (
    <img
      src={`/api/marketing/assets/${encodeURIComponent(id)}/bytes`}
      alt={`Generated image: ${title}`}
      loading="lazy"
      onError={() => setBlocked(true)}
      className="h-16 w-16 rounded-md border border-border object-cover"
    />
  )
}

export function AssetManager() {
  const [assets, setAssets] = useState<CrmDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setListError(null)
    try {
      const data = await get<ListResponse>('/api/documents?kind=marketing_asset')
      setAssets(data.documents ?? [])
    } catch (err) {
      setListError(describeError(err))
      setAssets([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function handleReview(doc: CrmDocument) {
    setNotice(null)
    try {
      const result = await post<ReviewResponse>(`/api/documents/${encodeURIComponent(doc.id)}/review`)
      setNotice({
        // The number is the point of the sentence. Confirming a picture that a
        // staged page already references moves that page's bytes, and Task 12 ends
        // the approval waiting on it. An owner who is not told their review just
        // cost somebody a re-stage reads a silent success as a no-op.
        kind: result.invalidatedBundles > 0 ? 'info' : 'ok',
        text:
          result.invalidatedBundles > 0
            ? `Confirmed ${doc.title} as ready. ${result.invalidatedBundles} staged bundle(s) went back to draft, so their approvals must be re-staged and re-predicted.`
            : `Confirmed ${doc.title} as ready.`,
      })
      await load()
    } catch (err) {
      setNotice({ kind: 'bad', text: describeError(err) })
    }
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-text-muted">
          Images generated for campaign bundles. They arrive flagged for review, and a
          bundle holding one that is still unreviewed cannot be staged.
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      {notice ? (
        <p
          role={notice.kind === 'bad' ? 'alert' : 'status'}
          className={
            notice.kind === 'bad'
              ? 'rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger'
              : notice.kind === 'ok'
                ? 'rounded-md border border-success-line bg-success-soft px-3 py-2 text-sm text-success'
                : 'rounded-md border border-border bg-bg-raised px-3 py-2 text-sm text-text-secondary'
          }
        >
          {notice.text}
        </p>
      ) : null}

      {loading ? <p className="text-sm text-text-muted">Loading generated images…</p> : null}

      {listError ? (
        <div role="alert" className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger">
          <p className="break-words">{listError}</p>
          <Button variant="ghost" size="sm" onClick={() => void load()} className="mt-2 h-7 px-2 text-danger hover:bg-danger-soft hover:text-danger">
            Retry
          </Button>
        </div>
      ) : null}

      {!loading && !listError && assets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          No generated images yet. A bundle needs a stored creative prompt set before
          marketing.generate_assets will spend anything.
        </div>
      ) : null}

      {assets.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-[0.06em] text-text-muted">
                <th scope="col" className="px-3 py-2 font-medium">Preview</th>
                <th scope="col" className="px-3 py-2 font-medium">Title</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">Format</th>
                <th scope="col" className="px-3 py-2 font-medium">Generated</th>
                <th scope="col" className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((doc) => (
                <tr key={doc.id} className="border-b border-border last:border-0 hover:bg-bg-hover">
                  <td className="px-3 py-2 align-top">
                    <Thumbnail id={doc.id} title={doc.title} />
                  </td>
                  <td className="px-3 py-2 align-top font-medium text-text-primary">{doc.title}</td>
                  <td className="px-3 py-2 align-top">
                    <Badge variant={statusVariant(doc.status)}>{doc.status}</Badge>
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-text-secondary">{doc.mime || '—'}</td>
                  <td className="px-3 py-2 align-top text-xs text-text-muted">
                    {new Date(doc.created_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 align-top">
                    {doc.status === 'needs_review' ? (
                      <Button variant="ghost" size="sm" onClick={() => void handleReview(doc)}>
                        Confirm
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
