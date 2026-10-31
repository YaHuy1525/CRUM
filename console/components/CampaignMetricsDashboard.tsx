'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

import { get, describeError } from '../lib/api'
import { PageHeader } from './PageHeader'
import { Badge } from './ui/badge'


export interface CampaignMetrics {
  bundleId: string
  campaignExternalId: string
  campaignName: string
  adAccountId: string
  status: 'ACTIVE' | 'PAUSED'
  impressions: number
  clicks: number
  spend: number
  leads: number
  costPerLead: number
  recommendation: 'scale' | 'hold' | 'kill' | null
  lastAnalystRun: string | null
}

export interface CampaignMetricsResponse {
  items: CampaignMetrics[]
}

export interface CampaignMetricsDashboardProps {
  tenantId: string
}

function recommendationVariant(rec: CampaignMetrics['recommendation']): 'success' | 'warning' | 'danger' | 'secondary' {
  if (rec === 'scale') return 'success'
  if (rec === 'hold') return 'warning'
  if (rec === 'kill') return 'danger'
  return 'secondary'
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

function formatCurrency(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export function CampaignMetricsDashboard({ tenantId }: CampaignMetricsDashboardProps) {
  const [items, setItems] = useState<CampaignMetrics[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await get<CampaignMetricsResponse>(
        `/api/marketing/campaign-metrics?tenantId=${encodeURIComponent(tenantId)}`,
      )
      setItems(data.items ?? [])
    } catch (err) {
      setError(describeError(err))
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [tenantId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="mx-auto w-full px-4 py-6 md:px-8 md:py-10">
      <PageHeader
        title="Campaign metrics"
        description="Past 7 days of performance for every active campaign, with the analyst's recommendation."
        actions={
          !loading && !error && items.length > 0 ? (
            <Badge variant="secondary">{items.length} campaigns</Badge>
          ) : undefined
        }
      />

      <div className="mt-4 flex items-center justify-end">
        <button
          type="button"
          className="text-sm text-text-secondary underline underline-offset-2 hover:text-text-primary"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Reload'}
        </button>
      </div>

      {loading ? <p className="mt-4 text-sm text-text-muted">Loading campaign metrics…</p> : null}

      {error ? (
        <div
          role="alert"
          className="mt-4 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          <p className="break-words">{error}</p>
          <button
            type="button"
            className="mt-2 text-sm text-danger underline underline-offset-2 hover:text-danger"
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      ) : null}

      {!loading && !error && items.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border-strong bg-bg-card p-8 text-center text-sm text-text-muted">
          No active campaigns to show.
        </div>
      ) : null}

      {!loading && !error && items.length > 0 ? (
        <div className="mt-4 overflow-x-auto rounded-lg border border-border bg-bg-card">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-bg-sunken text-xs uppercase tracking-wide text-text-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Campaign</th>
                <th className="px-4 py-3 font-medium">Ad account</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Impressions</th>
                <th className="px-4 py-3 font-medium text-right">Clicks</th>
                <th className="px-4 py-3 font-medium text-right">Spend</th>
                <th className="px-4 py-3 font-medium text-right">Leads</th>
                <th className="px-4 py-3 font-medium text-right">Cost / lead</th>
                <th className="px-4 py-3 font-medium">Recommendation</th>
                <th className="px-4 py-3 font-medium">Last analyst run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((row) => (
                <tr key={row.bundleId} className="hover:bg-bg-sunken/50">
                  <td className="px-4 py-3">
                    <Link
                      href={`/marketing/${encodeURIComponent(row.bundleId)}`}
                      className="font-medium text-text-primary underline underline-offset-2 hover:text-accent"
                    >
                      {row.campaignName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{row.adAccountId}</td>
                  <td className="px-4 py-3">
                    <Badge variant={row.status === 'ACTIVE' ? 'success' : 'secondary'}>
                      {row.status === 'ACTIVE' ? 'Active' : 'Paused'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-text-secondary">
                    {formatNumber(row.impressions)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-text-secondary">
                    {formatNumber(row.clicks)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-text-secondary">
                    {formatCurrency(row.spend)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-text-secondary">
                    {formatNumber(row.leads)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-text-secondary">
                    {row.leads > 0 ? formatCurrency(row.costPerLead) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {row.recommendation ? (
                      <Badge variant={recommendationVariant(row.recommendation)}>
                        {row.recommendation}
                      </Badge>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-muted">
                    {row.lastAnalystRun ? new Date(row.lastAnalystRun).toLocaleString() : '—'}
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
