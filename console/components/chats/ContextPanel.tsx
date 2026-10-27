'use client'

import { useCallback, useEffect, useState } from 'react'

import { describeError, get, post } from '@/lib/api'
import type { CustomerRow } from '@/lib/types'
import { ObjectPanel } from '@/components/ObjectPanel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'


interface CustomerPanelProps {
  customerId: string | null
  threadId?: string | null
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
  threadId?: string | null
  initialCustomerId?: string | null
}

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
