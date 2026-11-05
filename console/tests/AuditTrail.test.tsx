import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuditTrail } from '../components/AuditTrail'
import type { AuditRow } from '../lib/review'

function row(over: Partial<AuditRow> = {}): AuditRow {
  return {
    document_id: 'd1',
    tenant_id: 't1',
    table_name: 'invoices',
    field_name: 'total',
    action: 'update',
    old_value: '1200.00',
    new_value: '1100.00',
    changed_by: '00000000-0000-4000-8000-000000000002',
    changed_at: '2026-11-03T09:00:00.000Z',
    change_source: 'manual_correction',
    reason: 'vendor reissued',
    ...over,
  }
}

describe('AuditTrail', () => {
  it('says so when there is no history at all', () => {
    render(<AuditTrail rows={[]} onReload={vi.fn()} />)
    expect(screen.getByText(/no field changes recorded/i)).toBeInTheDocument()
  })

  it('renders old struck and new for an update', () => {
    render(<AuditTrail rows={[row()]} onReload={vi.fn()} />)
    expect(screen.getByText('1200.00')).toHaveClass('line-through')
    expect(screen.getByText('1100.00')).toBeInTheDocument()
  })

  it('names the source and the reason', () => {
    render(<AuditTrail rows={[row()]} onReload={vi.fn()} />)
    expect(screen.getByText('manual correction')).toBeInTheDocument()
    expect(screen.getByText('vendor reissued')).toBeInTheDocument()
  })

  it('leaves the reason slot empty rather than inventing one', () => {
    render(<AuditTrail rows={[row({ reason: null, change_source: 'extraction' })]} onReload={vi.fn()} />)
    expect(screen.getByText('extraction').closest('li')).toHaveTextContent('total')
  })

  it('renders an extraction row without an old value', () => {
    render(<AuditTrail rows={[row({ change_source: 'extraction', action: 'insert', old_value: null })]} onReload={vi.fn()} />)
    expect(screen.getByText('1100.00')).toBeInTheDocument()
    expect(screen.queryByText('1200.00')).not.toBeInTheDocument()
  })

  it('renders a numeric jsonb value as a number, not as quoted json', () => {
    render(<AuditTrail rows={[row({ new_value: 1200.5 })]} onReload={vi.fn()} />)
    expect(screen.getByText('1200.5')).toBeInTheDocument()
  })

  it('offers a reload', async () => {
    const onReload = vi.fn()
    render(<AuditTrail rows={[]} onReload={onReload} />)
    await userEvent.click(screen.getByRole('button', { name: /reload/i }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })
})
