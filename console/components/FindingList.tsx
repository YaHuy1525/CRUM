'use client'

import { useState } from 'react'

import type { StoredViolation } from '../lib/review'

const MIN_WAIVER_REASON = 8

export function FindingList({
  violations,
  onWaive,
}: {
  violations: readonly StoredViolation[]
  onWaive: (violationId: string, reason: string) => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  if (violations.length === 0) return null

  return (
    <ul className="space-y-1">
      {violations.map((v) => (
        <li key={v.id} className="rounded border border-border bg-bg-card px-2 py-1 text-xs">
          <span className={v.severity === 'error' ? 'text-danger font-semibold' : 'text-warning font-semibold'}>
            {v.severity}
          </span>
          <span className="mx-1 text-text-muted">{v.field}</span>
          <span className="text-text-primary">{v.message}</span>
          {v.status === 'waived' ? (
            <span className="ml-1 text-text-muted">
              waived{v.waiverReason ? `: ${v.waiverReason}` : ''}
            </span>
          ) : (
            <button
              type="button"
              className="ml-2 underline text-text-muted hover:text-text-primary"
              onClick={() => {
                void (async () => {
                  const reason = window.prompt('Why can this finding be ignored? A reason is required.')
                  if (reason === null) return
                  const trimmed = reason.trim()
                  if (trimmed.length < MIN_WAIVER_REASON) {
                    setError('A waiver reason needs at least 8 characters.')
                    return
                  }
                  setError(null)
                  await onWaive(v.id, trimmed)
                })()
              }}
            >
              waive
            </button>
          )}
        </li>
      ))}
      {error ? <li className="text-xs text-danger">{error}</li> : null}
    </ul>
  )
}
