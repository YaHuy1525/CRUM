'use client'

import { useCallback, useEffect, useState } from 'react'
import { get, describeError } from '../lib/api'
import type { ThreadRow, ThreadsResponse } from '../lib/types'

/**
 * The session sidebar, reading real threads. §4.2, §10.2.
 *
 * It replaces the hardcoded two-item mock. The list comes from
 * `GET /api/agent/threads`, which reads stored threads through the
 * AgentController — so the entries survive a restart and, as §16's Phase 1
 * acceptance required, rendering the list provisions no workspace, no model and no
 * run.
 *
 * A failure is rendered as a failure. That matters more here than in most panels:
 * an empty list and an unfetched list look identical, and the difference decides
 * whether the operator goes looking for conversations that were never stored or
 * notices that the server is not answering.
 */

interface SessionListProps {
  /** Highlighted row. Owned by the parent, because the parent owns which chat is open. */
  activeThreadId?: string | null
  /** Fired when the user picks a conversation. */
  onSelect?: (threadId: string) => void
  /** Change to force a re-read (after a turn ends, a new thread exists). */
  refreshKey?: string | number
}

/** Newest activity first, so the conversation the user was just in sits on top. */
function byRecent(a: ThreadRow, b: ThreadRow): number {
  return a.updated_at < b.updated_at ? 1 : -1
}

export function SessionList({ activeThreadId, onSelect, refreshKey }: SessionListProps = {}) {
  const [threads, setThreads] = useState<ThreadRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await get<ThreadsResponse>('/api/agent/threads')
      setThreads([...(data.sessions ?? [])].sort(byRecent))
    } catch (err) {
      // Keep the previous rows on screen: a failed refresh should not look like
      // the conversations disappeared.
      setError(describeError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  if (loading && threads.length === 0 && !error) {
    return <div className="empty-state">Loading conversations…</div>
  }

  return (
    <>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => void load()} aria-label="Retry" className="focus-ring">
            Retry
          </button>
        </div>
      )}

      <ul className="session-list" role="listbox" aria-label="Conversation sessions">
        {!error && threads.length === 0 && (
          <li className="empty-state" role="presentation">
            No conversations yet for this user.
          </li>
        )}

        {threads.map((thread) => {
          const isActive = activeThreadId === thread.id
          return (
            <li
              key={thread.id}
              className={`session-item focus-ring ${isActive ? 'active' : ''}`}
              role="option"
              aria-selected={isActive}
              tabIndex={0}
              onClick={() => onSelect?.(thread.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect?.(thread.id)
                }
              }}
            >
              {/* A thread the agent never named has a null title, so fall back to
                  the id rather than showing an empty row. */}
              <div className="session-title">{thread.title ?? thread.id}</div>
              <div className="session-meta">
                {new Date(thread.updated_at).toLocaleString()}
              </div>
            </li>
          )
        })}
      </ul>

      {threads.length > 0 && (
        <button onClick={() => void load()} aria-label="Refresh conversations" className="focus-ring">
          Refresh
        </button>
      )}
    </>
  )
}
