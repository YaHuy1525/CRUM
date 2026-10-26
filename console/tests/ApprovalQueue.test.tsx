import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApprovalQueue } from '../components/ApprovalQueue'
import { route, stubFetch, type FetchStub, type Reply, type Rule } from './fetchStub'
import type { QueueItem } from '../lib/types'

/**
 * The approval queue is the one panel in the console that writes a CRM row, so the
 * tests here are mostly about *which* endpoint a click reaches and what a refusal
 * looks like. Two failures are worth more than any rendering check: a button that
 * posts the run-level decision (approving the tool call and leaving the draft
 * uncommitted — a green screen over a write that never happened), and a 409/422
 * that renders as a generic failure the operator is invited to retry.
 */

const DRAFT_ID = 'd1d1d1d1-1111-4111-8111-111111111111'
const RUN_ID = 'run-4b4b4b4b'
const RECEIPT_ID = 'r9r9r9r9-0000-4000-8000-000000000000'

function item(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: DRAFT_ID,
    object_type: 'customer',
    operation: 'create',
    target_id: null,
    payload: { name: 'Nordwind Freight' },
    risk_score: 72,
    gate: 'approval',
    action_hash: 'a'.repeat(64),
    run_id: RUN_ID,
    thread_id: 'thread-1',
    requested_by: 'user-1',
    created_at: '2026-10-25T09:00:00.000Z',
    // Far future, so 'decidable' never depends on the clock of the run.
    expires_at: '2099-01-01T00:00:00.000Z',
    receipt_id: null,
    rejected_at: null,
    committed_at: null,
    committed_record_id: null,
    suspension: null,
    ...over,
  }
}

const queue = (items: QueueItem[]): Reply => ({ status: 200, body: { items, total: items.length } })

const receipt: Reply = {
  status: 200,
  body: {
    receipt: {
      id: RECEIPT_ID,
      pending_write_id: DRAFT_ID,
      run_id: RUN_ID,
      scope: 'draft:create:customer',
      signature: 'deadbeefcafebabe1234',
      approved_by: 'user-1',
      decision: 'approved',
      reason: null,
      committed_record_id: 'c-42',
      created_at: '2026-10-25T09:30:00.000Z',
      payload: { name: 'Nordwind Freight' },
    },
    signature_valid: true,
    verification: 'valid',
  },
}

let server: FetchStub

function mount(rules: Rule[]) {
  server = stubFetch(rules)
  return server
}

beforeEach(() => {
  server = stubFetch([])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ApprovalQueue', () => {
  it('lists what is waiting, from the plane', async () => {
    mount([route('/api/approvals/pending', queue([item()]))])
    render(<ApprovalQueue />)

    expect(await screen.findByText('Risk: 72')).toBeInTheDocument()
    expect(screen.getByText(/create customer · gate approval/)).toBeInTheDocument()
    // The payload preview is the whole point of a human gate: the decider has to
    // see the bytes being committed.
    expect(screen.getByText(/Nordwind Freight/)).toBeInTheDocument()
    expect(screen.getByText(/Requested by user-1/)).toBeInTheDocument()
    expect(server.calls.map((c) => c.url)).toEqual(['/api/approvals/pending'])
  })

  it('a suspended run is named on its draft, so the two halves of §11.3 line up', async () => {
    mount([
      route(
        '/api/approvals/pending',
        queue([item({ suspension: { run_id: RUN_ID, thread_id: 'thread-1', resource_id: 'tenant-1:user-1', tool_call_ids: ['call-1'] } })]),
      ),
    ])
    render(<ApprovalQueue />)
    expect(await screen.findByText(`Suspended run ${RUN_ID}`)).toBeInTheDocument()
  })

  it('Approve decides the draft, and never the run', async () => {
    const user = userEvent.setup()
    // State, not call counting: a committed draft leaves the pending queue, so the
    // queue answers empty once the decision has landed. That is what makes this
    // test check the right thing - the evidence of an approval cannot live on a
    // row that is gone, so the panel must keep it somewhere else.
    let decided = false
    // A rule returns a reply ({status, body}), not a reply wrapped in a reply: the
    // queue helper already is one, which is why it is returned directly here.
    mount([
      route('/api/approvals/pending', () => queue(decided ? [] : [item()])),
      route('/decision', () => {
        decided = true
        return { status: 201, body: { status: 'approved', pending_write_id: DRAFT_ID, receipt_id: RECEIPT_ID } }
      }),
      route('/api/approvals/receipts/', receipt),
    ])
    render(<ApprovalQueue />)

    await user.click(await screen.findByRole('button', { name: 'Approve' }))

    const call = server.last('/decision')
    // The run-level `/api/approvals/:runId/decision` only releases the pause; it
    // does not write the row. If this ever points there, the queue is lying.
    expect(call?.url).toBe(`/api/approvals/drafts/${DRAFT_ID}/decision`)
    expect(call?.url).not.toContain(RUN_ID)
    expect(call?.method).toBe('POST')
    expect(call?.body).toEqual({ approved: true })

    // The draft is out of the queue, and the signed verdict stayed on screen.
    await waitFor(() => expect(screen.getByText('Nothing waiting for a decision.')).toBeInTheDocument())
    expect(await screen.findByText('Signature verified')).toBeInTheDocument()
    // Split across a text node and a <code>, so match the halves separately: a
    // regex spanning both would never match, because RTL reads an element's own
    // text nodes and not those of its children.
    expect(screen.getByText(/the signed receipt is the evidence/)).toBeInTheDocument()
    expect(screen.getByText('d1d1d1d1')).toBeInTheDocument()
    expect(server.last('/api/approvals/receipts/')?.url).toBe(`/api/approvals/receipts/${RECEIPT_ID}`)
    // Read once on mount, once after the decision.
    expect(server.count('/api/approvals/pending')).toBe(2)
  })

  it('Reject sends a reason, because an empty audit field is not a rationale', async () => {
    const user = userEvent.setup()
    mount([
      route('/api/approvals/pending', queue([item()])),
      route('/decision', { status: 201, body: { status: 'rejected', pending_write_id: DRAFT_ID, receipt_id: RECEIPT_ID } }),
      route('/api/approvals/receipts/', receipt),
    ])
    render(<ApprovalQueue />)

    await user.click(await screen.findByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(screen.getByText(/Rejected\. Receipt/)).toBeInTheDocument())
    expect(server.last('/decision')?.body).toEqual({ approved: false, reason: 'Rejected from the approval queue' })
  })

  it('a second decision is reported as a conflict, and the stale row is re-read', async () => {
    const user = userEvent.setup()
    mount([
      route('/api/approvals/pending', queue([item()])),
      route('/decision', { status: 409, body: { error: 'already_decided', detail: 'this draft has already been decided' } }),
    ])
    render(<ApprovalQueue />)

    await user.click(await screen.findByRole('button', { name: 'Approve' }))
    const note = await screen.findByRole('status')
    expect(note.textContent).toContain('Already decided')

    // Refresh after a conflict, or the queue keeps offering a button that can only
    // ever 409 again.
    await waitFor(() => expect(server.count('/api/approvals/pending')).toBe(2))
  })

  it('a draft this build cannot apply is not shown as a retryable failure', async () => {
    const user = userEvent.setup()
    mount([
      route('/api/approvals/pending', queue([item({ object_type: 'invoice', operation: 'update' })])),
      route('/decision', { status: 422, body: { error: 'not_committable', detail: 'no committer for invoice/update' } }),
    ])
    render(<ApprovalQueue />)

    await user.click(await screen.findByRole('button', { name: 'Approve' }))
    const note = await screen.findByRole('status')
    expect(note.textContent).toContain('cannot apply the draft')
    expect(note.textContent).toContain('no committer for invoice/update')
    // Retrying cannot help a 422, so the queue must not have gone back out.
    expect(server.count('/api/approvals/pending')).toBe(1)
  })

  it('an expired window offers no buttons, only an explanation', async () => {
    mount([route('/api/approvals/pending', queue([item({ expires_at: '2020-01-01T00:00:00.000Z' })]))])
    render(<ApprovalQueue />)

    expect(await screen.findByText(/the window has closed/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
  })

  it('a queue it cannot read is not reported as an empty queue', async () => {
    mount([route('/api/approvals/pending', { status: 401, body: { error: 'unauthorized', reason: 'missing-claim' } })])
    render(<ApprovalQueue />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('missing-claim')
    expect(screen.queryByText(/Nothing waiting for a decision/)).toBeNull()
  })

  it('the Decided tab reads decided drafts and expands their receipts', async () => {
    const user = userEvent.setup()
    mount([
      route('/api/approvals/pending', queue([])),
      route(
        '/api/approvals/resolved',
        queue([
          item({
            receipt_id: RECEIPT_ID,
            committed_at: '2026-10-25T09:31:00.000Z',
            committed_record_id: 'c-42',
          }),
        ]),
      ),
      route('/api/approvals/receipts/', receipt),
    ])
    render(<ApprovalQueue />)

    expect(await screen.findByText('Nothing waiting for a decision.')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Decided' }))

    expect(await screen.findByText(/Record c-42/)).toBeInTheDocument()
    expect(server.last('/api/approvals/resolved')?.url).toBe('/api/approvals/resolved')
    // Buttons belong to pending drafts only; a decided one is history.
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Show receipt' }))
    expect(await screen.findByText('Signature verified')).toBeInTheDocument()
  })

  it('a forged receipt is called a forgery, not an error', async () => {
    const user = userEvent.setup()
    mount([
      route('/api/approvals/pending', queue([])),
      route('/api/approvals/resolved', queue([item({ receipt_id: RECEIPT_ID, committed_at: '2026-10-25T09:31:00.000Z' })])),
      route('/api/approvals/receipts/', { ...receipt, body: { ...receipt.body as object, verification: 'invalid', signature_valid: false } }),
    ])
    render(<ApprovalQueue />)

    await user.click(await screen.findByRole('tab', { name: 'Decided' }))
    await user.click(await screen.findByRole('button', { name: 'Show receipt' }))
    expect(await screen.findByText('Signature DOES NOT match this receipt')).toBeInTheDocument()
  })
})
