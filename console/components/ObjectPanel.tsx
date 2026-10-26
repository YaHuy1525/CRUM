'use client'

import type { CustomerRow } from '../lib/types'


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
