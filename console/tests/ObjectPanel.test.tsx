import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ObjectPanel } from '../components/ObjectPanel'

describe('ObjectPanel', () => {
  it('renders the Active Object heading', () => {
    render(<ObjectPanel />)
    expect(screen.getByText('Active Object')).toBeInTheDocument()
  })

  it('renders the Working Memory heading', () => {
    render(<ObjectPanel />)
    expect(screen.getByText('Working Memory')).toBeInTheDocument()
  })

  it('shows the empty state for no object bound', () => {
    render(<ObjectPanel />)
    expect(screen.getByText('No object bound')).toBeInTheDocument()
  })

  it('shows the empty state for no facts noted', () => {
    render(<ObjectPanel />)
    expect(screen.getByText('No facts noted')).toBeInTheDocument()
  })
})
