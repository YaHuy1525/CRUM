'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { describeError, get } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/PageHeader'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The `/usage` page body. §"Route map": "Token, cost, and tool metrics."
 *
 * This was the last surface in the console still reading class names from the
 * legacy stylesheet, still calling `fetch()` around the typed client, and still
 * printing `--` for a number it never received. All three are fixed here rather
 * than restyled, so the component now reads like its siblings:
 *
 * 1. `get<UsageMetrics>` from `lib/api`, so a plane failure arrives as an
 *    `ApiError` with the plane's own sentence and `describeError` names the port,
 *    instead of the old `body.error || HTTP status` string assembled in place.
 * 2. TanStack Query owns the read, so the range inputs drive a `queryKey` and a
 *    retry is `refetch()` rather than the old trick of setting the same range
 *    back into state to wake the effect.
 * 3. The four states are the shared recipes: skeletons while reading, an
 *    `role="alert"` band on failure, and the numbers themselves in a table a
 *    screen reader can announce (caption plus header row, which the old bare
 *    `<tbody>`-only table had neither of).
 *
 * `GET /api/usage` answers 503 when the storage backend cannot serve metrics.
 * That arrives as an error here, which is the truth: the metrics were not read.
 */

/** `GET /api/usage` body, camelCase because the route returns the store's own shape. */
interface UsageMetrics {
  tokensIn: number
  tokensOut: number
  cost: number
  cacheReadTokens: number
  cacheWriteTokens: number
  toolCallCount: number
  toolCallErrors: number
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`
}

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

/**
 * A `YYYY-MM-DD` in the operator's own calendar. `toISOString().slice(0, 10)` is
 * UTC, which is one day earlier for anyone east of Greenwich before 10:00 local,
 * and this console's operator runs at UTC+11. The same fix landed on the Home
 * digest card in Phase 4; the range defaults had the identical bug.
 */
function localISO(date: Date): string {
  return [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

/** The last seven local days, inclusive of today. */
function defaultDateRange(): { from: string; to: string } {
  const now = new Date()
  return {
    from: localISO(new Date(Date.now() - 7 * 86400000)),
    to: localISO(now),
  }
}

export function UsageDashboard() {
  const [range, setRange] = useState(defaultDateRange)

  const query = useQuery({
    queryKey: ['usage', range.from, range.to],
    queryFn: () =>
      get<UsageMetrics>(`/api/usage?${new URLSearchParams(range).toString()}`),
  })

  const metrics = query.data

  const cacheHitRate =
    metrics && metrics.cacheReadTokens + metrics.cacheWriteTokens > 0
      ? metrics.cacheReadTokens / (metrics.cacheReadTokens + metrics.cacheWriteTokens)
      : null

  const toolErrorRate =
    metrics && metrics.toolCallCount > 0 ? metrics.toolCallErrors / metrics.toolCallCount : null

  /**
   * The six cards always exist, in this order, so the swap from reading to numbers
   * does not move the grid. A value is a string because every cell either has a
   * number or has a fact about why it has none: `cacheHitRate` and `toolErrorRate`
   * are ratios over a denominator that can legitimately be zero, and a blank or a
   * fabricated 0% would both be a lie about a cache that simply was not used.
   */
  const cards: { label: string; value: string }[] = [
    { label: 'Tokens In', value: metrics ? formatNumber(metrics.tokensIn) : '' },
    { label: 'Tokens Out', value: metrics ? formatNumber(metrics.tokensOut) : '' },
    { label: 'Cost', value: metrics ? formatCost(metrics.cost) : '' },
    {
      label: 'Cache Hit Rate',
      value: metrics ? (cacheHitRate === null ? 'No cache traffic' : formatPercent(cacheHitRate)) : '',
    },
    { label: 'Tool Calls', value: metrics ? formatNumber(metrics.toolCallCount) : '' },
    {
      label: 'Tool Error Rate',
      value: metrics ? (toolErrorRate === null ? 'No tool calls' : formatPercent(toolErrorRate)) : '',
    },
  ]

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8 md:py-10">
      <PageHeader
        title="Usage"
        description="Tokens, cost and tool calls for the selected range."
        actions={
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="usage-from" className="mb-1 block text-xs text-text-muted">
                From
              </label>
              <Input
                id="usage-from"
                type="date"
                value={range.from}
                max={range.to}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
                className="w-40"
              />
            </div>
            <div>
              <label htmlFor="usage-to" className="mb-1 block text-xs text-text-muted">
                To
              </label>
              <Input
                id="usage-to"
                type="date"
                value={range.to}
                min={range.from}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
                className="w-40"
              />
            </div>
          </div>
        }
      />

      {query.isPending ? (
        <div className="mt-6" aria-busy="true">
          <span className="sr-only" role="status">
            Reading usage metrics.
          </span>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((card) => (
              <div key={card.label} className="rounded-md border border-border bg-bg-card p-5">
                {/* The real label with only its number still unknown: the grid the
                 * reader is waiting for is already named, and the swap does not
                 * reflow it. */}
                <p className="text-xs font-semibold uppercase tracking-[var(--tracking-label)] text-text-muted">
                  {card.label}
                </p>
                <Skeleton className="mt-2 h-7 w-20" />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {query.isError ? (
        <div
          className="mt-6 rounded-lg border border-danger-line bg-danger-soft p-5 text-sm text-danger"
          role="alert"
          data-testid="usage-error"
        >
          <p className="font-medium text-text-primary">Could not read usage.</p>
          <p className="mt-1 font-mono text-xs">{describeError(query.error)}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {metrics ? (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((card) => (
              <div
                key={card.label}
                className="rounded-md border border-border bg-bg-card p-5 shadow-sm"
              >
                <p className="text-xs font-semibold uppercase tracking-[var(--tracking-label)] text-text-muted">
                  {card.label}
                </p>
                <p className="mt-2 font-display text-2xl text-text-primary">{card.value}</p>
              </div>
            ))}
          </div>

          <section className="mt-8">
            <h2 className="text-xl text-text-primary">Breakdown</h2>
            <div className="mt-3 overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[24rem] text-sm">
                <caption className="sr-only">
                  Cache and tool-call counts for {range.from} to {range.to}
                </caption>
                <thead>
                  <tr className="border-b border-border bg-bg-sunken text-left text-xs uppercase tracking-[var(--tracking-label)] text-text-muted">
                    <th scope="col" className="px-4 py-2 font-semibold">
                      Metric
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-semibold">
                      Value
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['Cache Read Tokens', formatNumber(metrics.cacheReadTokens)],
                    ['Cache Write Tokens', formatNumber(metrics.cacheWriteTokens)],
                    ['Tool Call Errors', formatNumber(metrics.toolCallErrors)],
                  ].map(([label, value]) => (
                    <tr key={label} className="border-b border-border last:border-b-0">
                      <th
                        scope="row"
                        className="px-4 py-2 text-left font-normal text-text-secondary"
                      >
                        {label}
                      </th>
                      <td className="px-4 py-2 text-right font-mono text-text-primary">
                        {value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </main>
  )
}
