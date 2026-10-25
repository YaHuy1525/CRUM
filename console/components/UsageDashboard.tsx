'use client'

import { useState, useEffect } from 'react'

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

function defaultDateRange(): { from: string; to: string } {
  const to = new Date()
  const from = new Date(Date.now() - 7 * 86400000)
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  }
}

export function UsageDashboard() {
  const [metrics, setMetrics] = useState<UsageMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [range, setRange] = useState(defaultDateRange)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const params = new URLSearchParams({ from: range.from, to: range.to })
    fetch(`/api/usage?${params}`)
      .then((res) => {
        if (!res.ok) {
          return res.json().then((body) => {
            throw new Error(body.error || `HTTP ${res.status}`)
          })
        }
        return res.json()
      })
      .then((data: UsageMetrics) => {
        if (!cancelled) {
          setMetrics(data)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to fetch usage data')
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [range])

  const cacheHitRate =
    metrics && metrics.cacheReadTokens + metrics.cacheWriteTokens > 0
      ? metrics.cacheReadTokens / (metrics.cacheReadTokens + metrics.cacheWriteTokens)
      : null

  const toolErrorRate =
    metrics && metrics.toolCallCount > 0
      ? metrics.toolCallErrors / metrics.toolCallCount
      : null

  if (loading) {
    return (
      <div className="usage-dashboard">
        <div className="usage-header">
          <div>
            <h1>Usage</h1>
            <p className="page-sub">Tokens and cost across the selected range.</p>
          </div>
        </div>
        <div className="usage-loading">Loading metrics...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="usage-dashboard">
        <div className="usage-header">
          <div>
            <h1>Usage</h1>
            <p className="page-sub">Tokens and cost across the selected range.</p>
          </div>
        </div>
        <div className="usage-error">
          <p>Failed to load usage data</p>
          <p className="usage-error-detail">{error}</p>
          <button onClick={() => setRange({ ...range })}>Retry</button>
        </div>
      </div>
    )
  }

  if (!metrics) {
    return (
      <div className="usage-dashboard">
        <div className="usage-header">
          <div>
            <h1>Usage</h1>
            <p className="page-sub">Tokens and cost across the selected range.</p>
          </div>
        </div>
        <div className="empty-state">No usage data available</div>
      </div>
    )
  }

  return (
    <div className="usage-dashboard">
      <div className="usage-header">
        <div>
          <h1>Usage</h1>
          <p className="page-sub">Tokens and cost across the selected range.</p>
        </div>
        <div className="usage-range">
          <label>
            From{' '}
            <input
              type="date"
              value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
          </label>
          <label>
            To{' '}
            <input
              type="date"
              value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
          </label>
        </div>
      </div>

      <div className="usage-grid">
        <div className="usage-card">
          <div className="usage-card-label">Tokens In</div>
          <div className="usage-card-value">{formatNumber(metrics.tokensIn)}</div>
        </div>
        <div className="usage-card">
          <div className="usage-card-label">Tokens Out</div>
          <div className="usage-card-value">{formatNumber(metrics.tokensOut)}</div>
        </div>
        <div className="usage-card">
          <div className="usage-card-label">Cost</div>
          <div className="usage-card-value">{formatCost(metrics.cost)}</div>
        </div>
        <div className="usage-card">
          <div className="usage-card-label">Cache Hit Rate</div>
          <div className="usage-card-value">
            {cacheHitRate !== null ? formatPercent(cacheHitRate) : '--'}
          </div>
        </div>
        <div className="usage-card">
          <div className="usage-card-label">Tool Calls</div>
          <div className="usage-card-value">{formatNumber(metrics.toolCallCount)}</div>
        </div>
        <div className="usage-card">
          <div className="usage-card-label">Tool Error Rate</div>
          <div className="usage-card-value">
            {toolErrorRate !== null ? formatPercent(toolErrorRate) : '--'}
          </div>
        </div>
      </div>

      <div className="usage-detail">
        <h2>Breakdown</h2>
        <table className="usage-table">
          <tbody>
            <tr>
              <td>Cache Read Tokens</td>
              <td>{formatNumber(metrics.cacheReadTokens)}</td>
            </tr>
            <tr>
              <td>Cache Write Tokens</td>
              <td>{formatNumber(metrics.cacheWriteTokens)}</td>
            </tr>
            <tr>
              <td>Tool Call Errors</td>
              <td>{formatNumber(metrics.toolCallErrors)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
