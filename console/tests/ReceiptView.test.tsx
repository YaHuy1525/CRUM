import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReceiptView } from '../components/ReceiptView'
import { route, stubFetch, type FetchStub, type Reply } from './fetchStub'


const RECEIPT_ID = 'r9r9r9r9-0000-4000-8000-000000000000'

function reply(verification: 'valid' | 'invalid' | 'unavailable'): Reply {
  return {
    status: 200,
    body: {
      receipt: {
        id: RECEIPT_ID,
        pending_write_id: 'd1d1d1d1-1111-4111-8111-111111111111',
        run_id: 'run-4b4b4b4b',
        scope: 'draft:create:customer',
        signature: 'deadbeefcafebabe1234567890abcdef',
        approved_by: 'user-1',
        decision: 'approved',
        reason: null,
        committed_record_id: 'c-42',
        created_at: '2026-10-25T09:30:00.000Z',
        payload: { name: 'Nordwind Freight' },
      },
      signature_valid: verification === 'valid' ? true : verification === 'invalid' ? false : null,
      verification,
    },
  }
}

let server: FetchStub

beforeEach(() => {
  server = stubFetch([])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ReceiptView', () => {
  it('shows a verified receipt with the record it committed', async () => {
    server = stubFetch([route('/api/approvals/receipts/', reply('valid'))])
    const { container } = render(<ReceiptView receiptId={RECEIPT_ID} />)

    expect(await screen.findByText('Signature verified')).toBeInTheDocument()
    expect(screen.getByText('c-42')).toBeInTheDocument()
    expect(server.last('/api/approvals/receipts/')?.url).toBe(`/api/approvals/receipts/${RECEIPT_ID}`)
    expect(container.querySelector('code')?.textContent).toBe('deadbeefcafebabe…')
    expect(container.textContent).not.toContain('567890abcdef')
  })

  it('calls an invalid signature an invalid signature', async () => {
    server = stubFetch([route('/api/approvals/receipts/', reply('invalid'))])
    render(<ReceiptView receiptId={RECEIPT_ID} />)

    const verdict = await screen.findByText('Signature DOES NOT match this receipt')
    expect(verdict).toHaveAttribute('data-verdict', 'invalid')
  })

  it('says "could not be verified" rather than "forged" when the secret is missing', async () => {
    server = stubFetch([route('/api/approvals/receipts/', reply('unavailable'))])
    render(<ReceiptView receiptId={RECEIPT_ID} />)

    const verdict = await screen.findByText(/Signature could not be verified/)
    expect(verdict.textContent).toContain('APPROVAL_HMAC_SECRET')
    expect(verdict).toHaveAttribute('data-verdict', 'unavailable')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('approved')).toBeInTheDocument()
  })

  it('reports a receipt it cannot read instead of rendering an empty one', async () => {
    server = stubFetch([route('/api/approvals/receipts/', { status: 404, body: { error: 'not_found' } })])
    render(<ReceiptView receiptId={RECEIPT_ID} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('not_found')
    expect(alert.textContent).toContain(RECEIPT_ID.slice(0, 8))
  })
})
