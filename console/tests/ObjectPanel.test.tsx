import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ObjectPanel } from '../components/ObjectPanel'

describe('ObjectPanel', () => {
  it('renders customer name when bound', () => {
    const customer = {
      id: '770e8400-e29b-41d4-a716-446655440002',
      tenant_id: 'tenant-1',
      name: 'Acme Corp',
      city: 'Austin',
      tags: ['vip'],
      owner_id: 'owner-1',
      team_member_ids: ['member-1'],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
    render(<ObjectPanel customer={customer} />)
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
  })

  it('renders empty state when not bound', () => {
    render(<ObjectPanel customer={null} />)
    expect(screen.getByText(/no customer selected/i)).toBeInTheDocument()
  })
})
