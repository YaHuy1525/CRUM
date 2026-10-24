'use client'

import { useState, useEffect } from 'react'

interface DigestItem {
  id: string
  customer_id: string
  label: string
  updated_at?: string
}

interface DigestResult {
  date: string
  overdue: DigestItem[]
  todaySchedule: DigestItem[]
  staleFollowups: DigestItem[]
  summary: string
}

function formatRelativeDate(dateStr?: string): string {
  if (!dateStr) return '--'
  const d = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  return d.toISOString().slice(0, 10)
}

export function TodayView() {
  const [digest, setDigest] = useState<DigestResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const params = new URLSearchParams({ date })
    fetch(`/api/digest?${params}`, {
      headers: { 'x-tenant-id': 'default' },
    })
      .then((res) => {
        if (!res.ok) {
          return res.json().then((body) => {
            throw new Error(body.error || `HTTP ${res.status}`)
          })
        }
        return res.json()
      })
      .then((data: DigestResult) => {
        if (!cancelled) {
          setDigest(data)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to fetch digest')
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [date])

  if (loading) {
    return (
      <div className="today-view">
        <div className="today-header">
          <h1>Today</h1>
        </div>
        <div className="today-loading">Loading digest...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="today-view">
        <div className="today-header">
          <h1>Today</h1>
        </div>
        <div className="today-error">
          <p>Failed to load digest</p>
          <p className="today-error-detail">{error}</p>
          <button onClick={() => setDate(date)}>Retry</button>
        </div>
      </div>
    )
  }

  if (!digest) {
    return (
      <div className="today-view">
        <div className="today-header">
          <h1>Today</h1>
        </div>
        <div className="empty-state">No digest data available</div>
      </div>
    )
  }

  const totalItems = digest.overdue.length + digest.todaySchedule.length + digest.staleFollowups.length

  return (
    <div className="today-view">
      <div className="today-header">
        <h1>Today</h1>
        <div className="today-date">
          <label>
            Date{' '}
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="today-summary">{digest.summary}</div>

      <div className="today-stats">
        <div className="today-stat today-stat-overdue">
          <div className="today-stat-value">{digest.overdue.length}</div>
          <div className="today-stat-label">Overdue</div>
        </div>
        <div className="today-stat today-stat-schedule">
          <div className="today-stat-value">{digest.todaySchedule.length}</div>
          <div className="today-stat-label">Today</div>
        </div>
        <div className="today-stat today-stat-stale">
          <div className="today-stat-value">{digest.staleFollowups.length}</div>
          <div className="today-stat-label">Stale</div>
        </div>
      </div>

      {totalItems === 0 && (
        <div className="empty-state">Nothing pending — all clear for {digest.date}.</div>
      )}

      {digest.overdue.length > 0 && (
        <section className="today-section">
          <h2>Overdue Tasks ({digest.overdue.length})</h2>
          <ul className="today-list">
            {digest.overdue.map((item) => (
              <li key={item.id} className="today-list-item">
                <span className="today-item-label">{item.label}</span>
                <span className="today-item-meta">
                  {formatRelativeDate(item.updated_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {digest.todaySchedule.length > 0 && (
        <section className="today-section">
          <h2>Today&apos;s Schedule ({digest.todaySchedule.length})</h2>
          <ul className="today-list">
            {digest.todaySchedule.map((item) => (
              <li key={item.id} className="today-list-item">
                <span className="today-item-label">{item.label}</span>
                <span className="today-item-meta">
                  {formatRelativeDate(item.updated_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {digest.staleFollowups.length > 0 && (
        <section className="today-section">
          <h2>Stale Followups ({digest.staleFollowups.length})</h2>
          <ul className="today-list">
            {digest.staleFollowups.map((item) => (
              <li key={item.id} className="today-list-item">
                <span className="today-item-label">{item.label}</span>
                <span className="today-item-meta">
                  {formatRelativeDate(item.updated_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
