'use client'

import { useState } from 'react'
import { SessionList } from '../components/SessionList'
import { ChatPane } from '../components/ChatPane'
import { CustomerPanel } from '../components/ObjectPanel'

/**
 * The three-pane console: conversations, chat, bound object. §11.2.
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

export default function Home() {
  const [threadId, setThreadId] = useState<string>(() => newThreadId())
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [customerInput, setCustomerInput] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <div className="container">
      <div className="pane">
        <div className="pane-header">
          Sessions
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
        <div className="pane-header">
          Chat
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            thread {threadId.slice(0, 8)}
          </span>
        </div>
        {/* The key is what makes a thread switch safe: a fresh Chat instance per
            conversation, so no fragments of the previous one are still on screen. */}
        <ChatPane key={threadId} threadId={threadId} />
      </div>

      <div className="pane">
        <div className="pane-header">Context</div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            setCustomerId(customerInput.trim() || null)
          }}
          style={{ display: 'flex', gap: 8, padding: '12px' }}
        >
          <input
            value={customerInput}
            onChange={(e) => setCustomerInput(e.target.value)}
            placeholder="Customer uuid"
            aria-label="Customer id to bind"
            style={{ flex: 1 }}
            className="focus-ring"
          />
          <button type="submit" className="focus-ring">
            Load
          </button>
        </form>
        <CustomerPanel customerId={customerId} threadId={threadId} />
      </div>
    </div>
  )
}
