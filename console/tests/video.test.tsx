import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VideoOverview } from '../components/VideoOverview'
import { VideoAlerts } from '../components/VideoAlerts'
import { VideoBilling } from '../components/VideoBilling'
import { route, stubFetch, type FetchStub, type Reply, type Rule } from './fetchStub'
import type { BillingInvoice, RevenueAlert, RevenueOverviewResponse } from '../lib/types'

let server: FetchStub

beforeEach(() => {
  server = stubFetch([])
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mount(rules: Rule[]) {
  server = stubFetch(rules)
  return server
}

// ── fixtures shaped exactly like the /api/video/* router responses ─────────

function overviewPayload(): RevenueOverviewResponse {
  return {
    range: { from: null, to: null },
    totals: {
      currency: 'USD',
      platform_revenue: '1000.50',
      sponsorship_revenue: '434.06',
      grand_total: '1434.56',
      channels_with_earnings: 1,
    },
    channels: [
      {
        channel_id: '3f2a1b0c-0000-4000-8000-000000000001',
        channel_name: 'Tarot Weekly',
        platform: 'youtube',
        ownership: 'self',
        status: 'active',
        currency: 'USD',
        total_revenue: '1000.50',
        total_views: 51234,
        last_sync_at: '2026-10-20T05:00:00.000Z',
      },
    ],
    openAlerts: 2,
  }
}

const overviewReply: Reply = { status: 200, body: overviewPayload() }

function alert(over: Partial<RevenueAlert> = {}): RevenueAlert {
  return {
    id: 'a1a1a1a1-0000-4000-8000-000000000001',
    tenant_id: '00000000-0000-4000-8000-000000000001',
    channel_id: '3f2a1b0c-0000-4000-8000-000000000001',
    customer_id: null,
    owner_id: null,
    kind: 'revenue_drop',
    severity: 'warning',
    message: 'YouTube earnings dropped 42% versus the previous week',
    metrics: { drop_pct: 0.42 },
    dedup_key: 'revenue_drop:ch:2026-10-20',
    status: 'open',
    acknowledged_at: null,
    created_at: '2026-10-21T08:00:00.000Z',
    updated_at: '2026-10-21T08:00:00.000Z',
    ...over,
  }
}

function invoice(over: Partial<BillingInvoice> = {}): BillingInvoice {
  return {
    id: 'b2b2b2b2-0000-4000-8000-000000000002',
    tenant_id: '00000000-0000-4000-8000-000000000001',
    customer_id: 'c3c3c3c3-0000-4000-8000-000000000003',
    billing_profile_id: null,
    owner_id: null,
    period_start: '2026-10-01',
    period_end: '2026-10-31',
    channel_ids: [],
    platform_revenue: 900.5,
    sponsorship_revenue: 100,
    gross_revenue: 1000.5,
    currency: 'USD',
    fee_model: 'pct_of_revenue',
    fee_pct: 15,
    fee_flat_amount: null,
    computed_amount: 150.08,
    line_items: [],
    status: 'draft',
    invoice_number: 'INV-2026-10-001',
    issued_at: null,
    notes: null,
    created_at: '2026-10-31T10:00:00.000Z',
    updated_at: '2026-10-31T10:00:00.000Z',
    ...over,
  }
}

// ── VideoOverview ───────────────────────────────────────────────────────────

describe('VideoOverview', () => {
  it('renders the decimal-string totals and the channel table from the overview payload', async () => {
    mount([route('/api/video/revenue/overview', overviewReply)])
    render(<VideoOverview />)

    // grand_total rendered exactly as the server returned it (decimal text)
    expect(await screen.findByText('1434.56')).toBeInTheDocument()
    expect(screen.getByText('1000.50')).toBeInTheDocument()
    expect(screen.getByText('434.06')).toBeInTheDocument()
    expect(screen.getByText('Tarot Weekly')).toBeInTheDocument()
    expect(screen.getByText('51234')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument() // openAlerts card
    expect(server.last('/api/video/revenue/overview')?.url).toBe('/api/video/revenue/overview')
  })

  it('the Load action refetches with the from/to query pair', async () => {
    const user = userEvent.setup()
    mount([route('/api/video/revenue/overview', overviewReply)])
    render(<VideoOverview />)
    await screen.findByText('Tarot Weekly')

    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-10-31' } })
    await user.click(screen.getByRole('button', { name: 'Load' }))

    expect(server.last('/api/video/revenue/overview')?.url).toBe(
      '/api/video/revenue/overview?from=2026-10-01&to=2026-10-31',
    )
  })

  it('a rejected fetch shows role="alert" and does not fake loaded totals', async () => {
    mount([
      route('/api/video/revenue/overview', {
        status: 401,
        body: { error: 'unauthorized', reason: 'invalid-claim' },
      }),
    ])
    render(<VideoOverview />)

    const alertBox = await screen.findByRole('alert')
    expect(alertBox.textContent).toContain('unauthorized')
    expect(alertBox.textContent).toContain('invalid-claim')
    expect(screen.queryByText('1434.56')).toBeNull()
    expect(screen.queryByText('Tarot Weekly')).toBeNull()
  })
})

// ── VideoAlerts ─────────────────────────────────────────────────────────────

describe('VideoAlerts', () => {
  it('lists open alerts (default filter) for a human to act on', async () => {
    mount([
      route('/api/video/alerts', { status: 200, body: { alerts: [alert()], total: 1 } }, 'GET'),
    ])
    render(<VideoAlerts />)

    expect(await screen.findByText('YouTube earnings dropped 42% versus the previous week')).toBeInTheDocument()
    expect(screen.getByText('revenue_drop')).toBeInTheDocument()
    expect(screen.getByText('warning')).toBeInTheDocument()
    expect(server.last('/api/video/alerts')?.url).toBe('/api/video/alerts?status=open')
  })

  it('acknowledging POSTs the per-alert transition and re-reads the list', async () => {
    const user = userEvent.setup()
    const acknowledged = alert({ status: 'acknowledged', acknowledged_at: '2026-10-21T09:00:00.000Z' })
    let reads = 0
    mount([
      route(
        '/api/video/alerts?',
        () => ({
          status: 200,
          body: { alerts: reads++ === 0 ? [alert()] : [acknowledged], total: 1 },
        }),
        'GET',
      ),
      route('/acknowledge', { status: 200, body: { alert: acknowledged } }, 'POST'),
    ])
    render(<VideoAlerts />)

    await user.click(await screen.findByRole('button', { name: 'Acknowledge' }))

    const call = server.last('/acknowledge')
    expect(call?.method).toBe('POST')
    expect(call?.url).toBe(`/api/video/alerts/${alert().id}/acknowledge`)
    await waitFor(() => expect(screen.getByText('acknowledged')).toBeInTheDocument())
    expect(server.count('/api/video/alerts?')).toBe(2)
  })

  it('run detection POSTs /scan and reports exactly what came back', async () => {
    const user = userEvent.setup()
    mount([
      route('/api/video/alerts?', { status: 200, body: { alerts: [], total: 0 } }, 'GET'),
      route('/scan', { status: 200, body: { created: 2, skipped: 5 } }, 'POST'),
    ])
    render(<VideoAlerts />)

    await user.click(await screen.findByRole('button', { name: 'Run detection' }))

    expect(server.last('/scan')?.method).toBe('POST')
    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('2 created, 5 skipped')
  })
})

// ── VideoBilling ────────────────────────────────────────────────────────────

const invoicesReply: Reply = { status: 200, body: { invoices: [invoice()], total: 1 } }

async function fillGenerateForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    await screen.findByLabelText('Customer id'),
    'c3c3c3c3-0000-4000-8000-000000000003',
  )
  fireEvent.change(screen.getByLabelText('Period start'), { target: { value: '2026-10-01' } })
  fireEvent.change(screen.getByLabelText('Period end'), { target: { value: '2026-10-31' } })
}

describe('VideoBilling', () => {
  it('lists invoices with numeric money formatted and status badges', async () => {
    mount([route('/api/video/billing/invoices', invoicesReply, 'GET')])
    render(<VideoBilling />)

    expect(await screen.findByText('150.08 USD')).toBeInTheDocument()
    expect(screen.getByText('draft')).toBeInTheDocument()
    expect(screen.getByText('INV-2026-10-001')).toBeInTheDocument()
  })

  it('generating an invoice POSTs the exact contract body', async () => {
    const user = userEvent.setup()
    mount([
      route('/api/video/billing/invoices', invoicesReply, 'GET'),
      route('/api/video/billing/invoices', { status: 201, body: { invoice: invoice() } }, 'POST'),
    ])
    render(<VideoBilling />)

    await fillGenerateForm(user)
    await user.click(screen.getByRole('button', { name: 'Generate invoice' }))

    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('INV-2026-10-001')
    expect(status.textContent).toContain('150.08 USD')

    const posts = server.calls.filter(
      (c) => c.method === 'POST' && c.url === '/api/video/billing/invoices',
    )
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toEqual({
      customerId: 'c3c3c3c3-0000-4000-8000-000000000003',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
    })
  })

  it('a 422 refusal is shown as an alert with the reason, never as success', async () => {
    const user = userEvent.setup()
    mount([
      route('/api/video/billing/invoices', invoicesReply, 'GET'),
      route('/api/video/billing/invoices', { status: 422, body: { error: 'no-active-profile' } }, 'POST'),
    ])
    render(<VideoBilling />)

    await fillGenerateForm(user)
    await user.click(screen.getByRole('button', { name: 'Generate invoice' }))

    const alertBox = await screen.findByRole('alert')
    expect(alertBox.textContent).toContain('no-active-profile')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('approving an invoice POSTs /approve and re-reads', async () => {
    const user = userEvent.setup()
    const approved = invoice({ status: 'approved' })
    let reads = 0
    mount([
      route(
        '/api/video/billing/invoices',
        () => ({
          status: 200,
          body: { invoices: reads++ === 0 ? [invoice()] : [approved], total: 1 },
        }),
        'GET',
      ),
      route('/approve', { status: 200, body: { invoice: approved } }, 'POST'),
    ])
    render(<VideoBilling />)

    await user.click(await screen.findByRole('button', { name: 'Approve' }))

    const call = server.last('/approve')
    expect(call?.method).toBe('POST')
    expect(call?.url).toBe(`/api/video/billing/invoices/${invoice().id}/approve`)
    await waitFor(() => expect(screen.getByText('approved')).toBeInTheDocument())
  })
})
