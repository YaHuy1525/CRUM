'use client'

import type { CustomerRow } from '../lib/types'

/**
 * The object binding card. §4.2, §4.5.
 *
 * Presentational only: given a customer, show it. The *reading* half — the
 * `GET /api/crm/customers/:id` fetch and the `POST /api/signals/rebind` bind —
 * lives in `components/chats/ContextPanel.tsx`, which is the only surface that
 * renders this now. The duplicate `CustomerPanel` that used to sit here was
 * deleted rather than left as a second copy that could drift from the one the
 * routes actually use.
 *
 * The bind is a *signal*, not a header: there is no `x-crm-object-id` anywhere in
 * this build. `rebind` retains a `state` signal on the session, which
 * `src/mastra/processors/object-binding.ts` reads back into the request context on
 * the next turn, so the binding survives across turns instead of being re-sent.
 */

export type Customer = CustomerRow

interface ObjectPanelProps {
  customer: Customer | null
}

export function ObjectPanel({ customer }: ObjectPanelProps) {
  if (!customer) {
    return (
      <div className="rounded-md border border-dashed border-border-strong bg-bg-card p-4 text-sm text-text-muted" aria-label="Object details">
        <p>No customer selected</p>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border bg-bg-card p-4" aria-label="Object details">
      <h3 className="text-sm font-semibold text-text-primary">{customer.name}</h3>
      {customer.city && <p className="mt-1 text-sm text-text-secondary">{customer.city}</p>}
      {customer.tags && customer.tags.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-1">
          {customer.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-sm border border-border bg-accent-soft px-1.5 py-0.5 text-xs text-accent-bright"
            >
              {tag}
            </span>
          ))}
        </p>
      )}
      <p className="mt-2 truncate font-mono text-xs text-text-muted">{customer.id}</p>
    </div>
  )
}
