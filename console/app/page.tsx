'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { SessionList } from '../components/SessionList'
import { ConversationView } from '@/components/chats/ConversationView'
import { ContextPanel } from '@/components/chats/ContextPanel'

/**
 * The console home, on Cedar's skeleton: a chats column, a main thread whose
 * composer sits at the top under a greeting, and a right rail of stacked cards.
 * §11.2.
 *
 * Ownership here is the whole design: the transcript lives inside the
 * conversation surface (AI SDK state), so the page owns only which conversation
 * the workbench is *minting* — a fresh id, remounted per conversation so no
 * fragments of the previous one are still on screen.
 *
 * Two things moved out of this file during the Chats phase:
 *
 * - The transcript component. Home renders the same `ConversationView` the
 *   conversation route uses, with `hydrate={false}` because a freshly minted
 *   thread has no stored row until its first turn. The pane it replaced is gone,
 *   so the two surfaces cannot drift.
 * - The customer context bind. It now lives in `ContextPanel`, which `/chats/[id]`
 *   renders in its side column and Home drops into the rail — one implementation,
 *   two placements. Home no longer owns the bound row.
 *
 * Picking a stored conversation *navigates* to `/chats/[id]` instead of swapping
 * the pane in place. The old behaviour reopened an empty pane, because a thread
 * read has always been followed by nothing; the route is where hydration exists,
 * so the link is the honest one.
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
  const router = useRouter()
  const [threadId, setThreadId] = useState<string>(() => newThreadId())
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
            onClick={() => setThreadId(newThreadId())}
            className="focus-ring"
            aria-label="Start a new conversation"
          >
            New
          </button>
        </div>
        <SessionList
          activeThreadId={threadId}
          onSelect={(id) => {
            // A stored thread reopens on its own route, where the transcript is
            // actually hydrated. Swapping the pane in place would show an empty
            // conversation and claim it was this one.
            router.push(`/chats/${id}`)
          }}
        />
      </div>

      <div className="pane chat-pane">
        {/* Cedar's home opens with a greeting, not a toolbar. The thread id is a
            subordinate line under it, and the composer (rendered by
            ConversationView) is ordered directly beneath — CSS `order` does the
            placement. */}
        <div className="chat-hero">
          <h1>Welcome back.</h1>
          <p className="hero-sub">
            {dateLine}
            <span className="thread-id">thread {threadId.slice(0, 8)}</span>
          </p>
        </div>
        {/* The key is what makes a thread switch safe: a fresh Chat instance per
            conversation, so no fragments of the previous one are still on screen.
            `hydrate={false}` because this id is minted, not read — the server
            creates the row when the first turn lands. */}
        <ConversationView key={threadId} threadId={threadId} hydrate={false} />
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
        {/* The panel draws its own card and its own "Context" label, so Home
            places it directly instead of wrapping it in a second one. One
            implementation, two placements: `/chats/[id]` puts it in its side
            column, Home puts it in the rail. */}
        <ContextPanel threadId={threadId} />

        <RailPulse />
      </div>
    </div>
  )
}
