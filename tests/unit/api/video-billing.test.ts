// tests/unit/api/video-billing.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

/**
 * The Phase 5 billing + alerts routers, exercised over real HTTP with the DB
 * layer fully stubbed (vi.mock on both src/db/billing and src/db/alerts, so no
 * pg ever loads and the test is independent of the real query files). The
 * harness is copied from tests/unit/api/video-sponsorship.test.ts: identity gate
 * first, zod validation before the DB, and the status-transition factories
 * pinned to the exact status argument they hand the DB.
 */
const billing = vi.hoisted(() => ({
  upsertActiveBillingProfile: vi.fn(),
  listBillingProfiles: vi.fn(),
  deactivateBillingProfile: vi.fn(),
  generateInvoice: vi.fn(),
  getInvoice: vi.fn(),
  listInvoices: vi.fn(),
  setInvoiceStatus: vi.fn(),
}))

const alerts = vi.hoisted(() => ({
  listRevenueAlerts: vi.fn(),
  getRevenueAlert: vi.fn(),
  setRevenueAlertStatus: vi.fn(),
  detectRevenueAlerts: vi.fn(),
}))

vi.mock('../../../src/db/billing', () => billing)
vi.mock('../../../src/db/alerts', () => alerts)

import {
  createVideoBillingRouter,
  createVideoAlertsRouter,
} from '../../../src/api/video-billing'
import { parseEnv } from '../../../src/config/env'

const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const USER = '660e8400-e29b-41d4-a716-446655440009'
const PROFILE = '770e8400-e29b-41d4-a716-4466554400a1'
const INVOICE = '770e8400-e29b-41d4-a716-4466554400b2'
const ALERT = '770e8400-e29b-41d4-a716-4466554400c3'
const CHANNEL = '880e8400-e29b-41d4-a716-446655440011'
const CUSTOMER = '990e8400-e29b-41d4-a716-446655440022'

const AUTH = { 'x-tenant-id': TENANT, 'x-user-id': USER, 'x-user-role': 'admin' }

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}

function billingRouter(): Hono {
  return createVideoBillingRouter({ env: parseEnv({}) })
}

function alertsRouter(): Hono {
  return createVideoAlertsRouter({ env: parseEnv({}) })
}

function profileRow(over: Record<string, unknown> = {}) {
  return {
    id: PROFILE,
    tenant_id: TENANT,
    customer_id: CUSTOMER,
    owner_id: USER,
    fee_model: 'pct_of_revenue',
    management_fee_pct: 15,
    flat_amount: null,
    currency: 'USD',
    billing_period: 'monthly',
    bill_on_sponsorship: true,
    active: true,
    valid_from: '2026-01-01',
    valid_to: null,
    notes: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function invoiceRow(over: Record<string, unknown> = {}) {
  return {
    id: INVOICE,
    tenant_id: TENANT,
    customer_id: CUSTOMER,
    billing_profile_id: PROFILE,
    owner_id: USER,
    period_start: '2026-01-01',
    period_end: '2026-01-31',
    channel_ids: [CHANNEL],
    platform_revenue: 1000,
    sponsorship_revenue: 500,
    gross_revenue: 1500,
    currency: 'USD',
    fee_model: 'pct_of_revenue',
    fee_pct: 15,
    fee_flat_amount: null,
    computed_amount: 225,
    line_items: [],
    status: 'draft',
    invoice_number: null,
    issued_at: null,
    notes: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function alertRow(over: Record<string, unknown> = {}) {
  return {
    id: ALERT,
    tenant_id: TENANT,
    channel_id: CHANNEL,
    customer_id: CUSTOMER,
    owner_id: USER,
    kind: 'revenue_drop',
    severity: 'warning',
    message: 'Revenue dropped 40% week over week.',
    metrics: { dropPct: 0.4 },
    dedup_key: `${CHANNEL}:2026-01-15`,
    status: 'open',
    acknowledged_at: null,
    created_at: '2026-01-15T00:00:00.000Z',
    updated_at: '2026-01-15T00:00:00.000Z',
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('billing identity gate', () => {
  it('refuses before touching the database', async () => {
    const res = await billingRouter().request('/api/video/billing/profiles', {
      headers: { 'x-tenant-id': TENANT },
    })
    expect(res.status).toBe(401)
    expect((await json<{ error: string }>(res)).error).toBe('unauthorized')
    expect(billing.listBillingProfiles).not.toHaveBeenCalled()
  })
})

describe('alerts identity gate', () => {
  it('refuses before touching the database', async () => {
    const res = await alertsRouter().request('/api/video/alerts', {
      headers: { 'x-tenant-id': TENANT },
    })
    expect(res.status).toBe(401)
    expect((await json<{ error: string }>(res)).error).toBe('unauthorized')
    expect(alerts.listRevenueAlerts).not.toHaveBeenCalled()
  })
})

describe('GET /api/video/billing/profiles', () => {
  it('lists profiles with the resolved identity and parsed filters', async () => {
    billing.listBillingProfiles.mockResolvedValue([profileRow()])

    const body = await json<{ profiles: { id: string }[]; total: number }>(
      billingRouter().request(
        `/api/video/billing/profiles?customerId=${CUSTOMER}&active=true`,
        { headers: AUTH },
      ),
    )

    expect(body.total).toBe(1)
    expect(body.profiles[0]!.id).toBe(PROFILE)
    expect(billing.listBillingProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      expect.objectContaining({ customerId: CUSTOMER, active: true }),
    )
  })

  it('rejects a malformed customerId before the database', async () => {
    const res = await billingRouter().request(
      '/api/video/billing/profiles?customerId=not-a-uuid',
      { headers: AUTH },
    )
    expect(res.status).toBe(400)
    expect(billing.listBillingProfiles).not.toHaveBeenCalled()
  })

  it('rejects an active value that is not true/false', async () => {
    const res = await billingRouter().request(
      '/api/video/billing/profiles?active=maybe',
      { headers: AUTH },
    )
    expect(res.status).toBe(400)
    expect(billing.listBillingProfiles).not.toHaveBeenCalled()
  })
})

describe('POST /api/video/billing/profiles', () => {
  it('upserts an active profile, defaulting ownerId to the caller', async () => {
    billing.upsertActiveBillingProfile.mockResolvedValue(profileRow())

    const res = await billingRouter().request('/api/video/billing/profiles', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId: CUSTOMER,
        feeModel: 'pct_of_revenue',
        managementFeePct: 15,
        currency: 'USD',
        billingPeriod: 'monthly',
        validFrom: '2026-01-01',
      }),
    })

    expect(res.status).toBe(201)
    expect((await json<{ profile?: { id: string } }>(res)).profile?.id).toBe(PROFILE)
    expect(billing.upsertActiveBillingProfile).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ customerId: CUSTOMER, ownerId: USER, feeModel: 'pct_of_revenue' }),
    )
  })

  it('rejects an unknown feeModel before writing', async () => {
    const res = await billingRouter().request('/api/video/billing/profiles', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: CUSTOMER, feeModel: 'hourly' }),
    })
    expect(res.status).toBe(400)
    expect((await json<{ error?: string }>(res)).error).toBe('invalid_body')
    expect(billing.upsertActiveBillingProfile).not.toHaveBeenCalled()
  })

  it('rejects a missing customerId', async () => {
    const res = await billingRouter().request('/api/video/billing/profiles', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ feeModel: 'flat_retainer' }),
    })
    expect(res.status).toBe(400)
    expect(billing.upsertActiveBillingProfile).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/video/billing/profiles/:id', () => {
  it('deactivates a visible profile', async () => {
    billing.deactivateBillingProfile.mockResolvedValue(profileRow({ active: false }))
    const res = await billingRouter().request(`/api/video/billing/profiles/${PROFILE}`, {
      method: 'DELETE',
      headers: AUTH,
    })
    expect(res.status).toBe(200)
    expect(billing.deactivateBillingProfile).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      PROFILE,
    )
  })

  it('answers 404 when the profile is not found', async () => {
    billing.deactivateBillingProfile.mockResolvedValue(null)
    const res = await billingRouter().request(`/api/video/billing/profiles/${PROFILE}`, {
      method: 'DELETE',
      headers: AUTH,
    })
    expect(res.status).toBe(404)
    expect((await json<{ error?: string }>(res)).error).toBe('not_found')
  })
})

describe('GET /api/video/billing/invoices', () => {
  it('lists invoices with the resolved identity and status filter', async () => {
    billing.listInvoices.mockResolvedValue([invoiceRow()])

    const body = await json<{ invoices: { id: string }[]; total: number }>(
      billingRouter().request('/api/video/billing/invoices?status=draft', { headers: AUTH }),
    )

    expect(body.total).toBe(1)
    expect(billing.listInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      expect.objectContaining({ status: 'draft' }),
    )
  })

  it('rejects an unknown status filter', async () => {
    const res = await billingRouter().request('/api/video/billing/invoices?status=paid', {
      headers: AUTH,
    })
    expect(res.status).toBe(400)
    expect(billing.listInvoices).not.toHaveBeenCalled()
  })
})

describe('GET /api/video/billing/invoices/:id', () => {
  it('returns a visible invoice', async () => {
    billing.getInvoice.mockResolvedValue(invoiceRow())
    const body = await json<{ invoice?: { id: string } }>(
      billingRouter().request(`/api/video/billing/invoices/${INVOICE}`, { headers: AUTH }),
    )
    expect(body.invoice?.id).toBe(INVOICE)
  })

  it('answers 404 for an invoice it cannot see', async () => {
    billing.getInvoice.mockResolvedValue(null)
    const res = await billingRouter().request(`/api/video/billing/invoices/${INVOICE}`, {
      headers: AUTH,
    })
    expect(res.status).toBe(404)
    expect((await json<{ error?: string }>(res)).error).toBe('not_found')
  })
})

describe('POST /api/video/billing/invoices', () => {
  it('returns 201 with the generated invoice', async () => {
    billing.generateInvoice.mockResolvedValue({ ok: true, invoice: invoiceRow() })

    const res = await billingRouter().request('/api/video/billing/invoices', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId: CUSTOMER,
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
      }),
    })

    expect(res.status).toBe(201)
    expect((await json<{ invoice?: { id: string } }>(res)).invoice?.id).toBe(INVOICE)
    expect(billing.generateInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      { customerId: CUSTOMER, periodStart: '2026-01-01', periodEnd: '2026-01-31' },
    )
  })

  it('answers 422 with the reason when generation is refused', async () => {
    billing.generateInvoice.mockResolvedValue({ ok: false, reason: 'no-active-profile' })
    const res = await billingRouter().request('/api/video/billing/invoices', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId: CUSTOMER,
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
      }),
    })
    expect(res.status).toBe(422)
    expect((await json<{ error?: string }>(res)).error).toBe('no-active-profile')
  })

  it('rejects a malformed body before generating', async () => {
    const res = await billingRouter().request('/api/video/billing/invoices', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ customerId: 'not-a-uuid', periodStart: '2026-01-01', periodEnd: '2026-01-31' }),
    })
    expect(res.status).toBe(400)
    expect(billing.generateInvoice).not.toHaveBeenCalled()
  })
})

describe('POST /api/video/billing/invoices/:id transitions', () => {
  it('approve calls setInvoiceStatus with approved', async () => {
    billing.setInvoiceStatus.mockResolvedValue(invoiceRow({ status: 'approved' }))
    const res = await billingRouter().request(`/api/video/billing/invoices/${INVOICE}/approve`, {
      method: 'POST',
      headers: AUTH,
    })
    expect(res.status).toBe(200)
    expect(billing.setInvoiceStatus).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      INVOICE,
      'approved',
    )
  })

  it('issue calls setInvoiceStatus with issued', async () => {
    billing.setInvoiceStatus.mockResolvedValue(invoiceRow({ status: 'issued' }))
    const res = await billingRouter().request(`/api/video/billing/invoices/${INVOICE}/issue`, {
      method: 'POST',
      headers: AUTH,
    })
    expect(res.status).toBe(200)
    expect(billing.setInvoiceStatus).toHaveBeenCalledWith(expect.anything(), INVOICE, 'issued')
  })

  it('void calls setInvoiceStatus with void', async () => {
    billing.setInvoiceStatus.mockResolvedValue(invoiceRow({ status: 'void' }))
    const res = await billingRouter().request(`/api/video/billing/invoices/${INVOICE}/void`, {
      method: 'POST',
      headers: AUTH,
    })
    expect(res.status).toBe(200)
    expect(billing.setInvoiceStatus).toHaveBeenCalledWith(expect.anything(), INVOICE, 'void')
  })

  it('answers 404 when the transition row is gone', async () => {
    billing.setInvoiceStatus.mockResolvedValue(null)
    const res = await billingRouter().request(`/api/video/billing/invoices/${INVOICE}/approve`, {
      method: 'POST',
      headers: AUTH,
    })
    expect(res.status).toBe(404)
    expect((await json<{ error?: string }>(res)).error).toBe('not_found')
  })
})

describe('GET /api/video/alerts', () => {
  it('lists alerts with the resolved identity and parsed filters', async () => {
    alerts.listRevenueAlerts.mockResolvedValue([alertRow()])

    const body = await json<{ alerts: { id: string }[]; total: number }>(
      alertsRouter().request(`/api/video/alerts?status=open&channelId=${CHANNEL}`, { headers: AUTH }),
    )

    expect(body.total).toBe(1)
    expect(body.alerts[0]!.id).toBe(ALERT)
    expect(alerts.listRevenueAlerts).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      expect.objectContaining({ status: 'open', channelId: CHANNEL }),
    )
  })

  it('rejects an unknown kind filter', async () => {
    const res = await alertsRouter().request('/api/video/alerts?kind=bogus', { headers: AUTH })
    expect(res.status).toBe(400)
    expect(alerts.listRevenueAlerts).not.toHaveBeenCalled()
  })
})

describe('GET /api/video/alerts/:id', () => {
  it('returns a visible alert', async () => {
    alerts.getRevenueAlert.mockResolvedValue(alertRow())
    const body = await json<{ alert?: { id: string } }>(
      alertsRouter().request(`/api/video/alerts/${ALERT}`, { headers: AUTH }),
    )
    expect(body.alert?.id).toBe(ALERT)
  })

  it('answers 404 for an alert it cannot see', async () => {
    alerts.getRevenueAlert.mockResolvedValue(null)
    const res = await alertsRouter().request(`/api/video/alerts/${ALERT}`, { headers: AUTH })
    expect(res.status).toBe(404)
    expect((await json<{ error?: string }>(res)).error).toBe('not_found')
  })
})

describe('POST /api/video/alerts/:id transitions', () => {
  it('acknowledge calls setRevenueAlertStatus with acknowledged', async () => {
    alerts.setRevenueAlertStatus.mockResolvedValue(alertRow({ status: 'acknowledged' }))
    const res = await alertsRouter().request(`/api/video/alerts/${ALERT}/acknowledge`, {
      method: 'POST',
      headers: AUTH,
    })
    expect(res.status).toBe(200)
    expect(alerts.setRevenueAlertStatus).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      ALERT,
      'acknowledged',
    )
  })

  it('dismiss calls setRevenueAlertStatus with dismissed', async () => {
    alerts.setRevenueAlertStatus.mockResolvedValue(alertRow({ status: 'dismissed' }))
    const res = await alertsRouter().request(`/api/video/alerts/${ALERT}/dismiss`, {
      method: 'POST',
      headers: AUTH,
    })
    expect(res.status).toBe(200)
    expect(alerts.setRevenueAlertStatus).toHaveBeenCalledWith(expect.anything(), ALERT, 'dismissed')
  })
})

describe('POST /api/video/alerts/scan', () => {
  it('runs detection with tenant defaults and reports counts', async () => {
    alerts.detectRevenueAlerts.mockResolvedValue({ created: 2, skipped: 1 })

    const res = await alertsRouter().request('/api/video/alerts/scan', {
      method: 'POST',
      headers: AUTH,
    })

    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ created: 2, skipped: 1 })
    expect(alerts.detectRevenueAlerts).toHaveBeenCalledWith(TENANT, undefined)
  })

  it('forwards validated thresholds when a body is supplied', async () => {
    alerts.detectRevenueAlerts.mockResolvedValue({ created: 0, skipped: 3 })

    const res = await alertsRouter().request('/api/video/alerts/scan', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ thresholds: { dropPct: 0.3, spikePct: 0.5 } }),
    })

    expect(res.status).toBe(200)
    expect(alerts.detectRevenueAlerts).toHaveBeenCalledWith(TENANT, {
      thresholds: { dropPct: 0.3, spikePct: 0.5 },
    })
  })

  it('rejects out-of-range thresholds before detection', async () => {
    const res = await alertsRouter().request('/api/video/alerts/scan', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ thresholds: { dropPct: 5, spikePct: 0.5 } }),
    })
    expect(res.status).toBe(400)
    expect(alerts.detectRevenueAlerts).not.toHaveBeenCalled()
  })
})
