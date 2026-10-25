'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { SessionList } from '../components/SessionList'
import { ChatPane } from '../components/ChatPane'
import { CustomerPanel } from '../components/ObjectPanel'

/**
 * The console home, on Cedar's skeleton: a chats column, a main thread whose
 * composer sits at the top under a greeting, and a right rail of stacked cards.
 * §11.2.
 *
 * Ownership here is the whole design: the transcript lives inside `ChatPane`
 * (AI SDK state), so the page owns only the two things that must be shared —
 * which conversation is open, and which CRM row is bound to it — and forces a
 * clean remount of the chat when the first changes.
 *
 * `ModeSwitch` is gone rather than merely unrendered. The explore/operate lens it
 * implemented has no counterpart on the server: the callable tool surface comes
 * from `resolveActiveTools(role)` against `policy/tools.yaml` (§4.6.1, §4.6.2), and
 * a browser control that narrowed or widened it would be a client choosing its own
 * permissions. A radio group nobody renders is a trap for the next reader, so the
 * component and its test were deleted; the control returns with a server concept to
 * bind it to.
 */

/**
 * A conversation key. Not a secret and not an identity claim — just a uuid both
 * sides agree to file memory under, which is exactly how the server treats it
 * (`header('x-thread-id') ?? randomUUID()` in `src/mastra/index.ts`). Minted here
 * because the streamed reply does not carry the server's own id back to us.
 */
function newThreadId(): string {
  return crypto.randomUUID()
}

/**
 * The rail's pulse cards: Today's digest counts and the queue depth, read once
 * on mount from the same proxied endpoints the full pages use. While reading,
 * the cells pulse a skeleton (Cedar's product does the same); a failure shows
 * '--' rather than a fake zero — an unreadable queue is not an empty queue.
 */
function RailPulse() {
  const [digest, setDigest] = useState<{ overdue: number; today: number; stale: number } | null>(null)
  const [digestFailed, setDigestFailed] = useState(false)
  const [queueDepth, setQueueDepth] = useState<number | null>(null)
  const [queueFailed, setQueueFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({ date: new Date().toISOString().slice(0, 10) })

    fetch(`/api/digest?${params}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((d) => {
        if (!cancelled) {
          setDigest({
            overdue: d.overdue?.length ?? 0,
            today: d.todaySchedule?.length ?? 0,
            stale: d.staleFollowups?.length ?? 0,
          })
        }
      })
      .catch(() => {
        if (!cancelled) setDigestFailed(true)
      })

    fetch('/api/approvals/pending')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((d) => {
        if (!cancelled) setQueueDepth((d.items ?? []).length)
      })
      .catch(() => {
        if (!cancelled) setQueueFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Cedar's rail recipe: rows of icon + label + right-aligned count, not
  // giant stat numbers. The count is the only number on the row.
  const row = (label: string, value: number | null, failed: boolean) => (
    <div className="pulse-row-item">
      <span className="pulse-label">{label}</span>
      {!failed && value === null ? (
        <span className="skeleton-bar" aria-hidden="true" />
      ) : (
        <span className="pulse-count">{failed ? '--' : value}</span>
      )}
    </div>
  )

  return (
    <>
      <section className="rail-card" aria-label="Today at a glance">
        <h2 className="rail-card-label">Today</h2>
        {row('Overdue', digest?.overdue ?? null, digestFailed)}
        {row('Scheduled', digest?.today ?? null, digestFailed)}
        {row('Stale', digest?.stale ?? null, digestFailed)}
        <Link href="/today" className="rail-link focus-ring">
          Open today &rarr;
        </Link>
      </section>

      <section className="rail-card" aria-label="Approval queue at a glance">
        <h2 className="rail-card-label">Awaiting decision</h2>
        {row('In the queue', queueDepth, queueFailed)}
        <Link href="/approvals" className="rail-link focus-ring">
          Review approvals &rarr;
        </Link>
      </section>
    </>
  )
}

export default function Home() {
  const [threadId, setThreadId] = useState<string>(() => newThreadId())
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [customerInput, setCustomerInput] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  // Computed after mount so the server render and the client render cannot
  // disagree about which local day it is.
  const [dateLine, setDateLine] = useState('')

  useEffect(() => {
    setDateLine(
      new Date().toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }),
    )
  }, [])

  return (
    <div className="container">
      <div className="pane">
        <div className="pane-header">
          Chats
          <button
            onClick={() => {
              setThreadId(newThreadId())
              setCustomerId(null)
              setCustomerInput('')
            }}
            className="focus-ring"
            aria-label="Start a new conversation"
          >
            New
          </button>
        </div>
        <SessionList
          activeThreadId={threadId}
          refreshKey={refreshKey}
          onSelect={(id) => {
            setThreadId(id)
            // The transcript for a stored thread is not reloaded — the plane does
            // not project message history to the browser (§10.2) — so say which
            // conversation is open rather than pretending to restore it.
            setRefreshKey((k) => k + 1)
          }}
        />
      </div>

      <div className="pane chat-pane">
        {/* Cedar's home opens with a greeting, not a toolbar. The thread id is a
            subordinate line under it, and the composer (rendered by ChatPane)
            is ordered directly beneath — CSS `order` does the placement. */}
        <div className="chat-hero">
          <h1>Welcome back.</h1>
          <p className="hero-sub">
            {dateLine}
            <span className="thread-id">thread {threadId.slice(0, 8)}</span>
          </p>
        </div>
        {/* The key is what makes a thread switch safe: a fresh Chat instance per
            conversation, so no fragments of the previous one are still on screen. */}
        <ChatPane key={threadId} threadId={threadId} />
        <div className="quick-chips" aria-label="Quick actions">
          <Link href="/new" className="quick-chip focus-ring">
            New from text
          </Link>
          <Link href="/approvals" className="quick-chip focus-ring">
            Approvals
          </Link>
          <Link href="/knowledge" className="quick-chip focus-ring">
            Knowledge
          </Link>
          <Link href="/usage" className="quick-chip focus-ring">
            Usage
          </Link>
        </div>
      </div>

      <div className="rail">
        <section className="rail-card" aria-label="Conversation context">
          <h2 className="rail-card-label">Context</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setCustomerId(customerInput.trim() || null)
            }}
            className="context-bind"
          >
            <input
              value={customerInput}
              onChange={(e) => setCustomerInput(e.target.value)}
              placeholder="Customer uuid"
              aria-label="Customer id to bind"
              className="focus-ring"
            />
            <button type="submit" className="btn-secondary focus-ring">
              Load
            </button>
          </form>
          <CustomerPanel customerId={customerId} threadId={threadId} />
        </section>

        <RailPulse />
      </div>
    </div>
  )
}
