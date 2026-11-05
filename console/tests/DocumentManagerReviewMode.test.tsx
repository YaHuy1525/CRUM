import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentManager } from '../components/DocumentManager'
import { route, stubFetch, type FetchStub, type Reply } from './fetchStub'
import type { CrmDocument } from '../lib/types'

const DOC = 'a1a1a1a1-0000-4000-8000-000000000001'
const VIOL = 'v1v1v1v1-0000-4000-8000-000000000001'

function document(over: Partial<CrmDocument> = {}): CrmDocument {
  return {
    id: DOC, tenant_id: 't', owner_id: 'u', kind: 'invoice',
    title: 'Acme hosting invoice', source: 'upload', source_ref: null,
    content_hash: 'sha256:abc', mime: 'application/pdf', status: 'needs_review',
    confidence: '0.92', customer_id: null,
    created_at: '2026-10-20T09:00:00.000Z', updated_at: '2026-10-24T09:00:00.000Z',
    ...over,
  }
}

const QUEUE: Reply = {
  status: 200,
  body: {
    total: 1, limit: 50, nextCursor: null, hasMore: false,
    items: [{
      documentId: DOC, title: 'Acme hosting invoice', kind: 'invoice', status: 'needs_review',
      confidence: 0.92, lowestFieldConfidence: 0.2, openErrors: 1, openWarnings: 0,
      reasons: ['needs review', 'open error'], createdAt: '2026-10-20T09:00:00.000Z',
    }],
  },
}

const VIOLATION = {
  id: VIOL, documentId: DOC, rulesetVersion: 'v1', severity: 'error', ruleId: 'invoice.total.sum',
  field: 'total', message: 'Subtotal plus tax does not equal the total.', status: 'open',
  waivedBy: null, waivedAt: null, waiverReason: null, createdAt: '2026-11-03T09:00:00.000Z',
}

const DETAIL: Reply = {
  status: 200,
  body: {
    document: document(),
    invoice: {
      vendor_name: 'Acme Cloud', vendor_email: null, invoice_number: 'INV-1',
      invoice_date: '2026-03-01', due_date: null, currency: 'AUD',
      subtotal: '1000.00', tax: '100.00', total: '1200.00',
    },
    lines: [{ id: 'l1', description: 'Hosting', quantity: '1', unit_price: '1000.00', amount: '1000.00', currency: 'AUD' }],
  },
}

const VALIDATION: Reply = { status: 200, body: { documentId: DOC, rulesetVersion: 'v1', violations: [VIOLATION] } }
const AUDIT: Reply = {
  status: 200,
  body: { audit: [{
    document_id: DOC, tenant_id: 't', table_name: 'invoices', field_name: 'total', action: 'update',
    old_value: '1200.00', new_value: '1100.00', changed_by: 'u', changed_at: '2026-11-03T09:00:00.000Z',
    change_source: 'manual_correction', reason: 'vendor reissued',
  }] },
}

let server: FetchStub

beforeEach(() => {
  server = stubFetch([
    route('/api/documents/review-queue', QUEUE, 'GET'),
    route(`/api/documents/${DOC}/invoice`, DETAIL, 'GET'),
    route(`/api/documents/${DOC}/validation`, VALIDATION, 'GET'),
    route(`/api/documents/${DOC}/audit`, AUDIT, 'GET'),
    route(`/api/documents/${DOC}/invoices/total`, {
      status: 200,
      body: { success: true, openErrors: 0, openWarnings: 1, violations: [{ ...VIOLATION, severity: 'warning' }] },
    }, 'PATCH'),
    route('/api/documents?kind=invoice', { status: 200, body: { documents: [document()], total: 1 } }, 'GET'),
  ])
})

async function openReviewRow() {
  await userEvent.click(screen.getByRole('button', { name: /needs review/i }))
  await waitFor(() => expect(server.count('review-queue')).toBe(1))
  await userEvent.click(await screen.findByText('Acme hosting invoice'))
}

describe('DocumentManager review mode', () => {
  it('starts in the normal list and only switches source when the chip is clicked', async () => {
    render(<DocumentManager kind="invoice" />)
    await waitFor(() => expect(server.count('/api/documents?kind=invoice')).toBe(1))
    expect(server.count('review-queue')).toBe(0)
    await openReviewRow()
    expect(server.count('review-queue')).toBe(1)
  })

  it('shows the reason badges the queue computed', async () => {
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    expect(await screen.findByText('open error')).toBeInTheDocument()
    expect(screen.getByText('needs review')).toBeInTheDocument()
  })

  it('shows the lowest field confidence in the queue column', async () => {
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    expect(await screen.findByText('20%')).toBeInTheDocument()
  })

  it('loads findings and audit history when a review row opens', async () => {
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    await waitFor(() => expect(server.count(`/${DOC}/validation`)).toBe(1))
    await waitFor(() => expect(server.count(`/${DOC}/audit`)).toBe(1))
    expect(await screen.findByText('Subtotal plus tax does not equal the total.')).toBeInTheDocument()
    expect(screen.getByText('Field history')).toBeInTheDocument()
  })

  it('renders the total field as editable with a required reason while its error is open', async () => {
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    await screen.findByText('Subtotal plus tax does not equal the total.')
    await userEvent.click(screen.getByRole('button', { name: /edit/i }))
    expect(screen.getByText(/reason \(required\)/i)).toBeInTheDocument()
  })

  it('saves a correction and repaints from the response without a second validation call', async () => {
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    await screen.findByText('Subtotal plus tax does not equal the total.')
    await userEvent.click(screen.getAllByRole('button', { name: /edit/i })[0])
    await userEvent.type(screen.getByRole('textbox', { name: /^total$/i }), '1100.00')
    await userEvent.type(screen.getByRole('textbox', { name: /reason/i }), 'vendor reissued the invoice')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(server.count(`/${DOC}/invoices/total`)).toBe(1))
    await waitFor(() => expect(screen.getByText(/1 warning still open/i)).toBeInTheDocument())
    expect(server.count(`/${DOC}/validation`)).toBe(1)
  })

  it('waives a finding with a reason and refetches the list', async () => {
    server = stubFetch([
      route('/api/documents/review-queue', QUEUE, 'GET'),
      route(`/api/documents/${DOC}/invoice`, DETAIL, 'GET'),
      route(`/api/documents/${DOC}/validation`, VALIDATION, 'GET'),
      route(`/api/documents/${DOC}/audit`, AUDIT, 'GET'),
      route(`/validation/${VIOL}/waive`, { status: 200, body: { violation: { ...VIOLATION, status: 'waived' } } }, 'POST'),
    ])
    vi.stubGlobal('prompt', vi.fn(() => 'confirmed with the vendor by phone'))
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    await userEvent.click(await screen.findByRole('button', { name: /waive/i }))
    await waitFor(() => expect(server.count('/waive')).toBe(1))
    await waitFor(() => expect(server.count(`/${DOC}/validation`)).toBe(3))
  })

  it('re-checks on demand and paints the newest findings', async () => {
    server = stubFetch([
      route('/api/documents/review-queue', QUEUE, 'GET'),
      route(`/api/documents/${DOC}/invoice`, DETAIL, 'GET'),
      route(`/api/documents/${DOC}/validation`, VALIDATION, 'GET'),
      route(`/api/documents/${DOC}/validation`, {
        status: 200, body: { documentId: DOC, rulesetVersion: 'v1', violations: [] },
      }, 'POST'),
      route(`/api/documents/${DOC}/audit`, AUDIT, 'GET'),
    ])
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    await screen.findByText('Subtotal plus tax does not equal the total.')
    await userEvent.click(screen.getByRole('button', { name: /re-check/i }))
    await waitFor(() => expect(screen.queryByText('Subtotal plus tax does not equal the total.')).not.toBeInTheDocument())
  })

  it('switching back to the full list leaves review mode without a stuck selection', async () => {
    render(<DocumentManager kind="invoice" />)
    await openReviewRow()
    await screen.findByText('Subtotal plus tax does not equal the total.')
    await userEvent.click(screen.getByRole('button', { name: /all invoices/i }))
    await waitFor(() => expect(server.count('review-queue')).toBe(1))
    expect(screen.queryByText('Subtotal plus tax does not equal the total.')).not.toBeInTheDocument()
  })

  it('keeps the read-only detail when not in review mode', async () => {
    render(<DocumentManager kind="invoice" />)
    await waitFor(() => expect(server.count('/api/documents?kind=invoice')).toBe(1))
    await userEvent.click(await screen.findByText('Acme hosting invoice'))
    await waitFor(() => expect(server.count(`/${DOC}/invoice`)).toBe(1))
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument()
    expect(server.count(`/${DOC}/validation`)).toBe(0)
  })
})
