'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { describeError, get } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/PageHeader'
import { Skeleton } from '@/components/ui/skeleton'


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

function localISO(date: Date): string {
  return [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

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
