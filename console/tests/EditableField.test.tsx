import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EditableField } from '../components/EditableField'
import { route, stubFetch, type FetchStub } from './fetchStub'
import type React from 'react'

const DOC = 'd1d1d1d1-0000-4000-8000-000000000001'
const PATCHED = { success: true, openErrors: 0, openWarnings: 1, violations: [] }

let server: FetchStub

beforeEach(() => {
  server = stubFetch([route('/invoices/total', { status: 200, body: PATCHED }, 'PATCH')])
})

type FieldProps = React.ComponentProps<typeof EditableField>

function props(over: Partial<FieldProps> = {}): FieldProps {
  return {
    documentId: DOC,
    tableName: 'invoices',
    field: 'total',
    label: 'Total',
    value: '1200.00',
    confidence: 0.95,
    findings: [],
    requiredReason: false,
    onCorrected: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

describe('EditableField', () => {
  it('shows the current value and an edit affordance', () => {
    render(<EditableField {...props()} />)
    expect(screen.getByText('Total')).toBeInTheDocument()
    expect(screen.getByText('1200.00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
  })

  it('does nothing until the reviewer saves', async () => {
    render(<EditableField {...props()} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.clear(screen.getByRole('textbox', { name: /total/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /total/i }), '1100.00')
    expect(server.count('/invoices/total')).toBe(0)
  })

  it('sends the new value with no reason when one is not required', async () => {
    render(<EditableField {...props()} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.clear(screen.getByRole('textbox', { name: /total/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /total/i }), '1100.00')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(server.last('/invoices/total')?.body).toEqual({ value: '1100.00' }))
  })

  it('refuses to send when a reason is required and blank', async () => {
    render(<EditableField {...props({ requiredReason: true })} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /total/i }), '1100.00')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(screen.getByText(/reason is required/i)).toBeInTheDocument())
    expect(server.count('/invoices/total')).toBe(0)
  })

  it('sends value and reason together once the reason is long enough', async () => {
    render(<EditableField {...props({ requiredReason: true })} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.clear(screen.getByRole('textbox', { name: /^total$/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /^total$/i }), '1100.00')
    await userEvent.type(screen.getByRole('textbox', { name: /reason/i }), 'vendor reissued the invoice')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() =>
      expect(server.last('/invoices/total')?.body).toEqual({ value: '1100.00', reason: 'vendor reissued the invoice' }),
    )
  })

  it('reports the open error count that came back with the correction', async () => {
    render(<EditableField {...props()} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /total/i }), '1100.00')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(screen.getByText(/1 warning still open/i)).toBeInTheDocument())
  })

  it('tells the parent so it can repaint', async () => {
    const onCorrected = vi.fn().mockResolvedValue(undefined)
    render(<EditableField {...props({ onCorrected })} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /total/i }), '1100.00')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(onCorrected).toHaveBeenCalledTimes(1))
  })

  it('surfaces a server rejection instead of swallowing it', async () => {
    server = stubFetch([route('/invoices/total', { status: 400, body: { error: 'reason_required' } }, 'PATCH')])
    render(<EditableField {...props()} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /total/i }), '1100.00')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(screen.getByText(/reason_required/i)).toBeInTheDocument())
  })

  it('cancels back to the value it started with', async () => {
    render(<EditableField {...props()} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /total/i }), '999')
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.getByText('1200.00')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('routes a contract field to the contract path', async () => {
    server = stubFetch([route('/contracts/contract_value', { status: 200, body: PATCHED }, 'PATCH')])
    render(<EditableField {...props({ tableName: 'contracts', field: 'contract_value', label: 'Contract value' })} />)
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /contract value/i }), '50000')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(server.count('/contracts/contract_value')).toBe(1))
  })
})
