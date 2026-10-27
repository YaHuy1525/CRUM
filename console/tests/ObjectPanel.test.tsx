import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { ObjectPanel } from '../components/ObjectPanel'
import type { CustomerRow } from '../lib/types'

function row(over: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: '770e8400-e29b-41d4-a716-446655440002',
    tenant_id: 'tenant-1',
    name: 'Acme Corp',
    city: 'Austin',
    tags: ['vip'],
    owner_id: 'owner-1',
    team_member_ids: ['member-1'],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  }
}

describe('ObjectPanel', () => {
  it('renders customer name when bound', () => {
    render(<ObjectPanel customer={row()} />)
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText('Austin')).toBeInTheDocument()
    expect(screen.getByText('vip')).toBeInTheDocument()
    expect(screen.getByText(row().id)).toBeInTheDocument()
  })

  it('renders empty state when not bound', () => {
    render(<ObjectPanel customer={null} />)
    expect(screen.getByText(/no customer selected/i)).toBeInTheDocument()
  })

  it('omits the optional lines a sparse row does not carry', () => {
    render(<ObjectPanel customer={row({ city: null, tags: null })} />)
    expect(screen.queryByText('Austin')).toBeNull()
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
  })
})
