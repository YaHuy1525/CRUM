import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FindingList } from '../components/FindingList'
import type { StoredViolation } from '../lib/review'

function violation(over: Partial<StoredViolation> = {}): StoredViolation {
  return {
    id: 'v1v1v1v1-0000-4000-8000-000000000001',
    documentId: 'd1d1d1d1-0000-4000-8000-000000000001',
    rulesetVersion: 'v1',
    severity: 'error',
    ruleId: 'invoice.total.sum',
    field: 'total',
    message: 'Subtotal plus tax does not equal the total.',
    status: 'open',
    waivedBy: null,
    waivedAt: null,
    waiverReason: null,
    createdAt: '2026-11-03T09:00:00.000Z',
    ...over,
  }
}

beforeEach(() => vi.stubGlobal('confirm', vi.fn(() => true)))
afterEach(() => vi.unstubAllGlobals())

describe('FindingList', () => {
  it('renders nothing when there is nothing to say', () => {
    const { container } = render(<FindingList violations={[]} onWaive={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the message with its severity named in words', () => {
    render(<FindingList violations={[violation()]} onWaive={vi.fn()} />)
    expect(screen.getByText('Subtotal plus tax does not equal the total.')).toBeInTheDocument()
    expect(screen.getByRole('listitem')).toHaveTextContent('error')
  })

  it('shows a warning as a warning, not as an error', () => {
    render(<FindingList violations={[violation({ severity: 'warning', ruleId: 'invoice.currency.shape' })]} onWaive={vi.fn()} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('warning')
  })

  it('names the field the finding points at', () => {
    render(<FindingList violations={[violation({ field: 'lines.amount' })]} onWaive={vi.fn()} />)
    expect(screen.getByRole('listitem')).toHaveTextContent('lines.amount')
  })

  it('offers waive on an open finding', () => {
    render(<FindingList violations={[violation()]} onWaive={vi.fn()} />)
    expect(screen.getByRole('button', { name: /waive/i })).toBeInTheDocument()
  })

  it('asks for a reason and passes it up', async () => {
    const onWaive = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('prompt', vi.fn(() => 'vendor corrected it on the phone'))
    render(<FindingList violations={[violation()]} onWaive={onWaive} />)
    await userEvent.click(screen.getByRole('button', { name: /waive/i }))
    await waitFor(() => expect(onWaive).toHaveBeenCalledWith(violation().id, 'vendor corrected it on the phone'))
  })

  it('sends nothing when the reviewer cancels the prompt', async () => {
    const onWaive = vi.fn()
    vi.stubGlobal('prompt', vi.fn(() => null))
    render(<FindingList violations={[violation()]} onWaive={onWaive} />)
    await userEvent.click(screen.getByRole('button', { name: /waive/i }))
    await waitFor(() => expect(onWaive).not.toHaveBeenCalled())
  })

  it('sends nothing when the reason is shorter than the server will accept', async () => {
    const onWaive = vi.fn()
    vi.stubGlobal('prompt', vi.fn(() => 'sure'))
    render(<FindingList violations={[violation()]} onWaive={onWaive} />)
    await userEvent.click(screen.getByRole('button', { name: /waive/i }))
    await waitFor(() => expect(onWaive).not.toHaveBeenCalled())
    expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument()
  })

  it('shows a waived finding as waived, with who and why, and no waive button', () => {
    render(
      <FindingList
        violations={[violation({ status: 'waived', waiverReason: 'confirmed with the vendor', waivedAt: '2026-11-03T10:00:00.000Z' })]}
        onWaive={vi.fn()}
      />,
    )
    expect(screen.getByRole('listitem')).toHaveTextContent('waived')
    expect(screen.getByRole('listitem')).toHaveTextContent('confirmed with the vendor')
    expect(screen.queryByRole('button', { name: /waive/i })).not.toBeInTheDocument()
  })
})
