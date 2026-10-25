import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CustomerPanel, ObjectPanel } from '../components/ObjectPanel'
import { route, stubFetch, type FetchStub, type Reply, type Rule } from './fetchStub'
import type { CustomerRow } from '../lib/types'

const CUSTOMER_ID = '770e8400-e29b-41d4-a716-446655440002'
const THREAD_ID = '22222222-2222-4222-8222-222222222222'

function row(over: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: CUSTOMER_ID,
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

const loaded: Reply = { status: 200, body: { customer: row() } }

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

describe('ObjectPanel', () => {
  it('renders customer name when bound', () => {
    render(<ObjectPanel customer={row()} />)
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
  })

  it('renders empty state when not bound', () => {
    render(<ObjectPanel customer={null} />)
    expect(screen.getByText(/no customer selected/i)).toBeInTheDocument()
  })
})

describe('CustomerPanel', () => {
  it('reads the row over HTTP, on the same visibility rule as the agent tool', async () => {
    mount([route('/api/crm/customers/', loaded)])
    render(<CustomerPanel customerId={CUSTOMER_ID} threadId={THREAD_ID} />)

    expect(await screen.findByText('Acme Corp')).toBeInTheDocument()
    expect(server.calls.map((c) => c.url)).toEqual([`/api/crm/customers/${CUSTOMER_ID}`])
    expect(screen.getByText('Austin')).toBeInTheDocument()
    expect(screen.getByText('vip')).toBeInTheDocument()
  })

  it('fetches nothing without an id', async () => {
    mount([route('/api/crm/customers/', loaded)])
    render(<CustomerPanel customerId={null} />)

    expect(await screen.findByText(/no customer selected/i)).toBeInTheDocument()
    expect(server.calls).toHaveLength(0)
  })

  it('a row the caller may not see is reported as a refusal, not as an empty panel', async () => {
    // The route answers 404 for "no such row" and "not yours" alike, so the panel
    // must not turn either into the not-selected state.
    mount([route('/api/crm/customers/', { status: 404, body: { error: 'not_found' } })])
    render(<CustomerPanel customerId={CUSTOMER_ID} threadId={THREAD_ID} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('not_found')
    expect(screen.queryByText(/no customer selected/i)).toBeNull()
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /bind this customer/i })).toBeNull()
  })

  it('binding is a signal on the conversation, addressed by the thread id', async () => {
    const user = userEvent.setup()
    mount([
      route('/api/crm/customers/', loaded),
      route('/api/signals/rebind', {
        status: 200,
        body: { ok: true, session_id: THREAD_ID, signal: 'rebind', signal_id: 's1s1s1s1-9999', object_binding: { objectType: 'customer', objectId: CUSTOMER_ID } },
      }),
    ])
    render(<CustomerPanel customerId={CUSTOMER_ID} threadId={THREAD_ID} />)

    await user.click(await screen.findByRole('button', { name: /bind this customer/i }))

    const call = server.last('/api/signals/rebind')
    expect(call?.method).toBe('POST')
    expect(call?.body).toEqual({ objectType: 'customer', objectId: CUSTOMER_ID })
    // There is no `x-crm-object-id` header in this build: the binding is retained
    // session state, so the thread id is what makes it land on the right
    // conversation, and `lib/api` must not swallow it.
    expect(call?.headers['x-session-id']).toBe(THREAD_ID)
    expect(call?.headers['x-tenant-id']).toBeUndefined()

    await waitFor(() => expect(screen.getByText(/Bound to this conversation \(signal s1s1s1s1\)/)).toBeInTheDocument())
  })

  it('without a conversation it explains the prerequisite rather than posting into nowhere', async () => {
    const user = userEvent.setup()
    mount([route('/api/crm/customers/', loaded)])
    render(<CustomerPanel customerId={CUSTOMER_ID} />)

    await user.click(await screen.findByRole('button', { name: /bind this customer/i }))
    expect(await screen.findByText(/Open or pick a conversation first/)).toBeInTheDocument()
    expect(server.calls.filter((c) => c.url.includes('/api/signals/'))).toHaveLength(0)
  })

  it('an already-bound conversation does not offer a second bind', async () => {
    mount([route('/api/crm/customers/', loaded)])
    render(<CustomerPanel customerId={CUSTOMER_ID} threadId={THREAD_ID} bound />)

    const button = await screen.findByRole('button', { name: /bind this customer/i })
    expect(button).toBeDisabled()
    expect(button.textContent).toBe('Bound to this conversation')
  })
})
