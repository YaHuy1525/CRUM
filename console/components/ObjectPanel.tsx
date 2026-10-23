'use client'

export interface Customer {
  id: string
  tenant_id: string
  name: string
  city?: string
  tags?: string[]
  owner_id: string
  team_member_ids: string[]
  created_at: string
  updated_at: string
}

interface ObjectPanelProps {
  customer: Customer | null
}

export function ObjectPanel({ customer }: ObjectPanelProps) {
  if (!customer) {
    return (
      <div className="object-panel empty">
        <p>No customer selected</p>
      </div>
    )
  }

  return (
    <div className="object-panel">
      <h3>{customer.name}</h3>
      {customer.city && <p className="city">{customer.city}</p>}
      {customer.tags && customer.tags.length > 0 && (
        <p className="tags">{customer.tags.join(', ')}</p>
      )}
      <p className="id">{customer.id}</p>
    </div>
  )
}
