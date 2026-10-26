'use client'

import { useCallback, useEffect, useState } from 'react'

import { describeError, get, post } from '@/lib/api'
import type { CustomerRow } from '@/lib/types'
import { ObjectPanel } from '@/components/ObjectPanel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * The conversation context side panel. §"Chats section / Frontend": `/chats/[id]`
 * carries "the customer context bind as a conversation side panel moved off Home."
 *
 * Two pieces, deliberately kept apart (the same split the old `ObjectPanel.tsx`
 * drew, now with the *fetching* half living here and the presentational card left
 * where its own tests render it):
 *
 * - `CustomerPanel` reads. It fetches `GET /api/crm/customers/:id` — the HTTP face
 *   of the `crm.get_customer` tool, sharing its visibility predicate, so a panel
 *   cannot show a row the agent's own tool would refuse — and binds the
 *   conversation to that row with `POST /api/signals/rebind`.
 * - `ContextPanel` is the side panel: the bind form (which row to load) wrapped
 *   around `CustomerPanel`.
 *
 * The bind is a *signal*, not a header: there is no `x-crm-object-id` anywhere in
 * this build. `rebind` retains a `state` signal on the session, which
 * `src/mastra/processors/object-binding.ts` reads back into the request context on
 * the next turn, so the binding survives across turns instead of being re-sent.
 * That also means it needs a conversation to bind to: without a thread id the
 * button explains why rather than posting into nowhere.
 */

interface CustomerPanelProps {
  /** The row to show. Null renders the empty state and fetches nothing. */
  customerId: string | null
  /** Conversation to bind to, from the parent that owns the open chat. */
  threadId?: string | null
  /** Bound already? Lets the panel say so instead of offering a second bind. */
  bound?: boolean
}

export function CustomerPanel({ customerId, threadId, bound = false }: CustomerPanelProps) {
  const [customer, setCustomer] = useState<CustomerRow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [bindNote, setBindNote] = useState<string | null>(null)
  const [binding, setBinding] = useState(false)

  const load = useCallback(async () => {
    if (!customerId) {
      setCustomer(null)
      setError(null)
      return
    }
    setError(null)
    try {
      const data = await get<{ customer: CustomerRow }>(
        `/api/crm/customers/${encodeURIComponent(customerId)}`,
      )
      setCustomer(data.customer)
    } catch (err) {
      // 'not_found' is the server's answer to both "no such row" and "not yours",
      // so the panel repeats it rather than guessing which.
      setCustomer(null)
      setError(describeError(err))
    }
  }, [customerId])

  useEffect(() => {
    void load()
  }, [load])

  async function bind() {
    if (!customerId) return
    if (!threadId) {
      setBindNote('Open or pick a conversation first — the binding belongs to a thread.')
      return
    }
    setBinding(true)
    setBindNote(null)
    try {
      const res = await post<{ ok: boolean; signal_id: string }>(
        '/api/signals/rebind',
        { objectType: 'customer', objectId: customerId },
        { 'x-session-id': threadId },
      )
      setBindNote(`Bound to this conversation (signal ${res.signal_id.slice(0, 8)}).`)
    } catch (err) {
      setBindNote(describeError(err))
    } finally {
      setBinding(false)
    }
  }

  return (
    <div className="mt-3">
      {error && (
        <div
          role="alert"
          className="mb-2 flex items-center justify-between gap-3 rounded-md border border-danger-line bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          <span>{error}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            className="shrink-0 text-danger hover:bg-danger-soft hover:text-danger"
          >
            Retry
          </Button>
        </div>
      )}

      {/* A row that failed to load is not a row that was never picked. The
          presentational panel's empty state means "no selection", so it would be a
          lie next to an error banner — and the two together read as "nothing here". */}
      {customer ? (
        <ObjectPanel customer={customer} />
      ) : error ? (
        <div className="rounded-md border border-dashed border-border-strong bg-bg-card p-4 text-sm text-text-muted">
          <p>
            Customer <code className="font-mono">{customerId?.slice(0, 8)}</code> is not shown,
            because it could not be loaded.
          </p>
        </div>
      ) : (
        <ObjectPanel customer={null} />
      )}

      {customer && (
        <div className="mt-3">
          <Button
            onClick={() => void bind()}
            disabled={binding || bound}
            aria-label="Bind this customer to the conversation"
            variant="secondary"
            size="sm"
            className="w-full"
          >
            {bound ? 'Bound to this conversation' : binding ? 'Binding…' : 'Bind to conversation'}
          </Button>
          {bindNote && <p className="mt-2 text-xs text-text-muted">{bindNote}</p>}
        </div>
      )}
    </div>
  )
}

interface ContextPanelProps {
  /** Conversation the loaded row binds to. Null disables the bind with a hint. */
  threadId?: string | null
  /** Optionally open on a specific customer (e.g. linked from a record). */
  initialCustomerId?: string | null
}

/**
 * The side panel: a bind form (which customer to load) over `CustomerPanel`. This
 * is what `/chats/[id]` renders in its context column and what Home drops into its
 * rail, replacing the inline form + `CustomerPanel` that used to live there.
 */
export function ContextPanel({ threadId, initialCustomerId = null }: ContextPanelProps) {
  const [customerId, setCustomerId] = useState<string | null>(initialCustomerId)
  const [input, setInput] = useState('')

  return (
    <section
      className="rounded-lg border border-border bg-bg-card p-4"
      aria-label="Conversation context"
    >
      <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">Context</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setCustomerId(input.trim() || null)
        }}
        className="mt-3 flex items-center gap-2"
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Customer uuid"
          aria-label="Customer id to bind"
          className="flex-1"
        />
        <Button type="submit" variant="secondary" size="sm" className="shrink-0">
          Load
        </Button>
      </form>
      <CustomerPanel customerId={customerId} threadId={threadId} />
    </section>
  )
}
