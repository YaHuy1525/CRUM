import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentManager } from '../components/DocumentManager'
import { route, stubFetch, type FetchStub, type Reply, type Rule } from './fetchStub'
import type { CrmDocument } from '../lib/types'


const DOC_READY = 'a1a1a1a1-0000-4000-8000-000000000001'
const DOC_REVIEW = 'b2b2b2b2-0000-4000-8000-000000000002'

function document(over: Partial<CrmDocument> = {}): CrmDocument {
  return {
    id: DOC_READY,
    tenant_id: 'tenant-1',
    owner_id: 'user-1',
    kind: 'invoice',
    title: 'Acme hosting invoice',
    source: 'upload',
    source_ref: null,
    content_hash: 'sha256:abc',
    mime: 'application/pdf',
    status: 'ready',
    confidence: '0.92',
    customer_id: null,
    created_at: '2026-10-20T09:00:00.000Z',
    updated_at: '2026-10-24T09:00:00.000Z',
    ...over,
  }
}

const list = (documents: CrmDocument[]): Reply => ({ status: 200, body: { documents, total: documents.length } })

const INVOICE_DETAIL = {
  status: 200,
  body: {
    document: document(),
    invoice: {
      vendor_name: 'Acme Cloud',
      vendor_email: 'billing@acme.test',
      invoice_number: 'INV-2026-001',
      invoice_date: '2026-03-01',
      due_date: '2026-03-31',
      currency: 'USD',
      subtotal: '1000.00',
      tax: '100.00',
      total: '1100.00',
    },
    lines: [{ description: 'Compute seat', quantity: '2', unit_price: '500.00', amount: '1000.00', currency: 'USD' }],
  },
}

let server: FetchStub

beforeEach(() => {
  server = stubFetch([])
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mountWith(rules: Rule[]) {
  server = stubFetch(rules)
  return render(<DocumentManager kind="invoice" />)
}

describe('DocumentManager', () => {
  it('lists invoices and surfaces a needs_review row with a confirm action', async () => {
    mountWith([
      route(
        '/api/documents?kind=invoice',
        list([document(), document({ id: DOC_REVIEW, title: 'Untitled bill', status: 'needs_review', confidence: '0.4' })]),
        'GET',
      ),
    ])

    expect(await screen.findByText('Acme hosting invoice')).toBeInTheDocument()
    expect(screen.getByText('Untitled bill')).toBeInTheDocument()
    expect(screen.getByText('needs_review')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Confirm' })).toHaveLength(1)
  })

  it('posts a selected file as multipart to the intake upload route', async () => {
    const user = userEvent.setup()
    mountWith([
      route('/api/documents?kind=invoice', () => list([]), 'GET'),
      route(
        '/api/documents/upload',
        { status: 201, body: { documentId: DOC_READY, status: 'ready', kind: 'invoice', confidence: 0.9, chunkCount: 4, indexName: 'idx' } },
        'POST',
      ),
    ])

    await screen.findByText(/No invoices uploaded yet/)
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'bill.pdf', { type: 'application/pdf' })
    await user.upload(screen.getByLabelText('Upload a invoice'), file)

    await waitFor(() => expect(server.last('/api/documents/upload')?.method).toBe('POST'))
    expect(server.count('/api/documents/upload')).toBe(1)
    expect(await screen.findByRole('status')).toHaveTextContent('4 chunks indexed')
  })

  it('renders the typed invoice header and line items on View', async () => {
    const user = userEvent.setup()
    mountWith([
      route('/api/documents?kind=invoice', list([document()]), 'GET'),
      route(`/${DOC_READY}/invoice`, INVOICE_DETAIL, 'GET'),
    ])

    await user.click(await screen.findByRole('button', { name: 'View' }))

    expect(await screen.findByText('Acme Cloud')).toBeInTheDocument()
    expect(screen.getByText('INV-2026-001')).toBeInTheDocument()
    expect(screen.getByText(/1,100\.00/)).toBeInTheDocument()
    expect(screen.getByText('Compute seat')).toBeInTheDocument()
  })

  it('confirms a needs_review document through the review endpoint', async () => {
    const user = userEvent.setup()
    mountWith([
      route('/api/documents?kind=invoice', list([document({ id: DOC_REVIEW, title: 'Untitled bill', status: 'needs_review' })]), 'GET'),
      route(`/${DOC_REVIEW}/review`, { status: 200, body: { documentId: DOC_REVIEW, status: 'ready' } }, 'POST'),
    ])

    await user.click(await screen.findByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(server.last(`/${DOC_REVIEW}/review`)?.method).toBe('POST'))
    expect(await screen.findByRole('status')).toHaveTextContent('Confirmed Untitled bill')
  })
})
