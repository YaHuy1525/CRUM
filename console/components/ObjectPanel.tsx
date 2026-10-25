'use client'

import { useCallback, useEffect, useState } from 'react'
import { get, post, describeError } from '../lib/api'
import type { CustomerRow } from '../lib/types'

/**
 * The object binding panel. §4.2, §4.5.
 *
 * Two pieces, deliberately kept apart:
 *
 * - `ObjectPanel` is presentational (it was, and stays, the thing the unit tests
 *   render): given a customer, show it.
 * - `CustomerPanel` reads. It fetches `GET /api/crm/customers/:id` — the HTTP face
 *   of the `crm.get_customer` tool, sharing its visibility predicate, so a panel
 *   cannot show a row the agent's own tool would refuse — and it binds the
 *   conversation to that row with `POST /api/signals/rebind`.
 *
 * The bind is a *signal*, not a header: there is no `x-crm-object-id` anywhere in
 * this build. `rebind` retains a `state` signal on the session, which
 * `src/mastra/processors/object-binding.ts` reads back into the request context on
 * the next turn, so the binding survives across turns instead of being re-sent.
 * That also means it needs a conversation to bind to: without a thread id the
 * button explains why rather than posting into nowhere.
 */

export type Customer = CustomerRow

interface ObjectPanelProps {
  customer: Customer | null
}

export function ObjectPanel({ customer }: ObjectPanelProps) {
  if (!customer) {
    return (
      <div className="object-panel empty" aria-label="Object details">
        <p>No customer selected</p>
      </div>
    )
  }

  return (
    <div className="object-panel" aria-label="Object details">
      <h3>{customer.name}</h3>
      {customer.city && <p className="city">{customer.city}</p>}
      {customer.tags && customer.tags.length > 0 && (
        <p className="tags">{customer.tags.join(', ')}</p>
      )}
      <p className="id">{customer.id}</p>
    </div>
  )
}

interface CustomerPanelProps {
  /** The row to show. Null renders the empty state and fetches nothing. */
  customerId: string | null
  /** Conversation to bind to, from the parent that owns the open chat. */
  threadId?: string | null
  /** Bound already? Lets the panel say so instead of offering a second bind. */
  bound?: boolean
}

export function CustomerPanel({ customerId, threadId, bound = false }: CustomerPanelProps) {
  const [customer, setCustomer] = useState<Customer | null>(null)
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
      const data = await get<{ customer: Customer }>(`/api/crm/customers/${encodeURIComponent(customerId)}`)
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
    <div className="object-panel-wrap">
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button onClick={() => void load()} className="focus-ring">
            Retry
          </button>
        </div>
      )}

      {/* A row that failed to load is not a row that was never picked. The presentational
          panel's empty state means "no selection", so it would be a lie next to an
          error banner - and the two together read as "there is nothing here". */}
      {customer ? (
        <ObjectPanel customer={customer} />
      ) : error ? (
        <div className="object-panel empty" aria-label="Object details">
          <p>Customer <code>{customerId?.slice(0, 8)}</code> is not shown, because it could not be loaded.</p>
        </div>
      ) : (
        <ObjectPanel customer={null} />
      )}

      {customer && (
        <div style={{ padding: '8px 12px' }}>
          <button
            onClick={() => void bind()}
            disabled={binding || bound}
            aria-label="Bind this customer to the conversation"
            className="focus-ring"
          >
            {bound ? 'Bound to this conversation' : binding ? 'Binding…' : 'Bind to conversation'}
          </button>
          {bindNote && <p className="hint">{bindNote}</p>}
        </div>
      )}
    </div>
  )
}
