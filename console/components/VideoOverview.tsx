'use client'

import { useCallback, useEffect, useState } from 'react'

import { describeError, getRevenueOverview } from '../lib/api'
import type { RevenueOverviewResponse } from '../lib/types'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'

// Money in the overview payload is decimal-as-TEXT: it is rendered exactly as
// the server returned it. Never parseFloat/Number() it for display.

function money(value: string, currency: string | null): string {
  return currency ? `${value} ${currency}` : value
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-[0.06em] text-text-muted">{label}</p>
      <div className="mt-2 font-display text-2xl text-text-primary">{children}</div>
    </div>
  )
}

export function VideoOverview() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [overview, setOverview] = useState<RevenueOverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const load = useCallback(async (range: { from?: string; to?: string }) => {
    setLoading(true)
    setListError(null)
    try {
      const data = await getRevenueOverview(range)
      setOverview(data)
    } catch (err) {
      setListError(describeError(err))
      setOverview(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load({})
  }, [load])

  function handleLoad(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    void load({ from: from.trim() || undefined, to: to.trim() || undefined })
  }

  const totals = overview?.totals ?? null

  return (
    <div className="mt-2 space-y-4">
      <p className="text-sm text-text-muted">
        Platform earnings plus confirmed sponsorship deals, rolled up per channel. Empty dates mean
        all-time. Every number is read-only — this panel never moves money.
      </p>

      <form onSubmit={handleLoad} className="flex flex-wrap items-end gap-4">
        <div>
          <Label htmlFor="overview-from">From</Label>
          <Input
            id="overview-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            aria-label="From date"
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="overview-to">To</Label>
          <Input
            id="overview-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            aria-label="To date"
            className="mt-1"
          />
        </div>
        <Button type="submit" disabled={loading}>
          Load
        </Button>
      </form>

      {loading ? <p className="text-sm text-text-muted">Loading revenue overview…</p> : null}

      {listError ? (
        <div
          role="alert"
          className="rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          <p className="break-words">{listError}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load({})}
            className="mt-2 h-7 px-2 text-danger hover:bg-danger-soft hover:text-danger"
          >
            Retry
          </Button>
        </div>
      ) : null}

      {!loading && overview ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card label="Platform revenue">{totals!.platform_revenue}</Card>
            <Card label="Sponsorship revenue">{totals!.sponsorship_revenue}</Card>
            <Card label="Grand total">
              {totals!.grand_total}
              {totals!.currency ? (
                <span className="ml-1 text-sm text-text-muted">{totals!.currency}</span>
              ) : null}
            </Card>
            <Card label="Open alerts">{overview.openAlerts}</Card>
          </div>

          <p className="text-xs text-text-muted">
            {totals!.channels_with_earnings} channel(s) had earnings in this range. Money is shown
            exactly as aggregated (decimal text){totals!.currency ? ` in ${totals!.currency}` : ''}.
          </p>
        </>
      ) : null}

      {!loading && !listError && overview && overview.channels.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          No tracked channels for this tenant yet.
        </div>
      ) : null}

      {overview && overview.channels.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-[0.06em] text-text-muted">
                <th scope="col" className="px-3 py-2 font-medium">Channel</th>
                <th scope="col" className="px-3 py-2 font-medium">Platform</th>
                <th scope="col" className="px-3 py-2 font-medium">Ownership</th>
                <th scope="col" className="px-3 py-2 font-medium">Revenue</th>
                <th scope="col" className="px-3 py-2 font-medium">Views</th>
                <th scope="col" className="px-3 py-2 font-medium">Last sync</th>
              </tr>
            </thead>
            <tbody>
              {overview.channels.map((row) => (
                <tr key={row.channel_id} className="border-b border-border last:border-0 hover:bg-bg-hover">
                  <td className="px-3 py-2 align-top font-medium text-text-primary">
                    {row.channel_name ?? <span className="text-text-muted">(unnamed)</span>}
                  </td>
                  <td className="px-3 py-2 align-top text-text-secondary">{row.platform}</td>
                  <td className="px-3 py-2 align-top">
                    <Badge variant={row.ownership === 'client' ? 'warning' : 'secondary'}>
                      {row.ownership}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-text-primary">
                    {money(row.total_revenue, row.currency)}
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-text-secondary">
                    {row.total_views}
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-text-muted">
                    {row.last_sync_at ? new Date(row.last_sync_at).toLocaleString() : 'never'}
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
