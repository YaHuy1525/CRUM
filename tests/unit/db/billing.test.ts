import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import type { ClientBillingProfile } from '../../../src/db/types'

// ── shared mock plumbing (mirrors tests/unit/db/sponsorship.test.ts) ────────
// The whole module goes through getDbClient().query, so a stubbed Pool is
// enough — no live DB required.  video-queries is module-mocked wholesale
// (same pattern as tests/unit/video/scheduling.test.ts) because generateInvoice
// reads channel/earnings aggregates through it.

const mockQuery = vi.fn()
const mockPool = {
  query: mockQuery,
  end: vi.fn(),
} as unknown as Pool

vi.mock('pg', () => ({
  Pool: vi.fn(() => mockPool),
}))

vi.mock('../../../src/config/env', () => ({
  parseEnv: () => ({
    DATABASE_URL: 'postgres://test:test@localhost:5432/testdb',
    NODE_ENV: 'test',
  }),
}))

const videoDb = vi.hoisted(() => ({
  listVideoChannels: vi.fn(),
  getVideoEarningsByChannel: vi.fn(),
}))
vi.mock('../../../src/db/video-queries', () => videoDb)

const TENANT = 'tenant-1'
const USER = 'user-1'
const CUSTOMER = 'cust-1'
const ADMIN_CTX = { tenantId: TENANT, userId: USER, userRole: 'admin' as const }
const USER_CTX = { tenantId: TENANT, userId: USER, userRole: 'user' as const }

function sqlAt(callIndex = 0): string {
  return mockQuery.mock.calls[callIndex]![0] as string
}
function paramsAt(callIndex = 0): unknown[] {
  return mockQuery.mock.calls[callIndex]![1] as unknown[]
}

/** Find the first recorded query whose SQL contains `fragment`. */
function callWith(fragment: string): { sql: string; params: unknown[] } {
  const call = mockQuery.mock.calls.find((c) => (c[0] as string).includes(fragment))
  if (!call) throw new Error(`no recorded SQL containing: ${fragment}`)
  return { sql: call[0] as string, params: call[1] as unknown[] }
}

// A fully-populated raw profile row with DECIMAL columns as strings (pg shape).
function rawProfileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bp1',
    tenant_id: TENANT,
    customer_id: CUSTOMER,
    owner_id: USER,
    fee_model: 'pct_of_revenue',
    management_fee_pct: '15.000',
    flat_amount: null,
    currency: 'USD',
    billing_period: 'monthly',
    bill_on_sponsorship: true,
    active: true,
    valid_from: '2026-01-01',
    valid_to: null,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

// A fully-populated raw invoice row with DECIMAL columns as strings (pg shape).
function rawInvoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bi1',
    tenant_id: TENANT,
    customer_id: CUSTOMER,
    billing_profile_id: 'bp1',
    owner_id: USER,
    period_start: '2026-01-01',
    period_end: '2026-01-31',
    channel_ids: ['ch1'],
    platform_revenue: '1000.00',
    sponsorship_revenue: '500.00',
    gross_revenue: '1500.00',
    currency: 'USD',
    fee_model: 'pct_of_revenue',
    fee_pct: '15.000',
    fee_flat_amount: null,
    computed_amount: '225.00',
    line_items: [{ label: 'total_fee', amount: 225 }],
    status: 'draft',
    invoice_number: 'INV-2026-0001',
    issued_at: null,
    notes: null,
    created_at: '2026-01-31T00:00:00Z',
    updated_at: '2026-01-31T00:00:00Z',
    ...overrides,
  }
}

/** Build a full ClientBillingProfile for the pure fee-math tests. */
function profileFixture(
  overrides: Partial<ClientBillingProfile> = {},
): ClientBillingProfile {
  return {
    id: 'bp1',
    tenant_id: TENANT,
    customer_id: CUSTOMER,
    owner_id: USER,
    fee_model: 'pct_of_revenue',
    management_fee_pct: 10,
    flat_amount: null,
    currency: 'USD',
    billing_period: 'monthly',
    bill_on_sponsorship: true,
    active: true,
    valid_from: '2026-01-01',
    valid_to: null,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
  videoDb.listVideoChannels.mockReset()
  videoDb.getVideoEarningsByChannel.mockReset()
})

// ═══════════════════════════════════════════════════════════════════════════
//  computeManagementFee (pure, no DB)
// ═══════════════════════════════════════════════════════════════════════════

describe('billing – computeManagementFee', () => {
  it('pct_of_revenue bills platform + sponsorship when bill_on_sponsorship', async () => {
    const { computeManagementFee } = await import('../../../src/db/billing')
    const fee = computeManagementFee(
      profileFixture({ fee_model: 'pct_of_revenue', management_fee_pct: 10 }),
      { platformRevenue: 1000, sponsorshipRevenue: 500 },
    )

    expect(fee.computedAmount).toBe(150) // (1000 + 500) * 10%
    expect(fee.feeModel).toBe('pct_of_revenue')
    expect(fee.feePct).toBe(10)
    expect(fee.feeFlatAmount).toBeNull()
    expect(fee.lineItems.some((l) => l.label === 'sponsorship_revenue')).toBe(true)
    expect(fee.lineItems.at(-1)).toMatchObject({ label: 'total_fee', amount: 150 })
  })

  it('pct_of_revenue excludes sponsorship when bill_on_sponsorship is false', async () => {
    const { computeManagementFee } = await import('../../../src/db/billing')
    const fee = computeManagementFee(
      profileFixture({ fee_model: 'pct_of_revenue', management_fee_pct: 10, bill_on_sponsorship: false }),
      { platformRevenue: 1000, sponsorshipRevenue: 500 },
    )

    expect(fee.computedAmount).toBe(100) // platform only
    expect(fee.lineItems.some((l) => l.label === 'sponsorship_revenue')).toBe(false)
  })

  it('pct_of_revenue rounds the computed fee to 2 decimals', async () => {
    const { computeManagementFee } = await import('../../../src/db/billing')
    const fee = computeManagementFee(
      profileFixture({ fee_model: 'pct_of_revenue', management_fee_pct: 10, bill_on_sponsorship: false }),
      { platformRevenue: 999.99, sponsorshipRevenue: 0 },
    )

    // 999.99 * 0.10 = 99.999 -> round2 -> 100
    expect(fee.computedAmount).toBe(100)
  })

  it('flat_retainer ignores revenue entirely', async () => {
    const { computeManagementFee } = await import('../../../src/db/billing')
    const fee = computeManagementFee(
      profileFixture({ fee_model: 'flat_retainer', management_fee_pct: null, flat_amount: 2000 }),
      { platformRevenue: 12345.67, sponsorshipRevenue: 9999.99 },
    )

    expect(fee.computedAmount).toBe(2000)
    expect(fee.feePct).toBeNull()
    expect(fee.feeFlatAmount).toBe(2000)
  })

  it('hybrid stacks the flat amount on top of the percentage basis', async () => {
    const { computeManagementFee } = await import('../../../src/db/billing')
    const fee = computeManagementFee(
      profileFixture({ fee_model: 'hybrid', management_fee_pct: 10, flat_amount: 500 }),
      { platformRevenue: 1000, sponsorshipRevenue: 200 },
    )

    expect(fee.computedAmount).toBe(620) // 500 + 1200 * 10%
    expect(fee.feePct).toBe(10)
    expect(fee.feeFlatAmount).toBe(500)
    expect(fee.lineItems.some((l) => l.label === 'flat_retainer')).toBe(true)
    expect(fee.lineItems.some((l) => l.label === 'management_fee_pct')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  upsertActiveBillingProfile
// ═══════════════════════════════════════════════════════════════════════════

describe('billing – upsertActiveBillingProfile', () => {
  it('retires the prior active row first, then inserts the new active profile', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // UPDATE ... SET active = false
      .mockResolvedValueOnce({ rows: [rawProfileRow()] }) // INSERT ... RETURNING *

    const { upsertActiveBillingProfile } = await import('../../../src/db/billing')
    const row = await upsertActiveBillingProfile(TENANT, {
      customerId: CUSTOMER,
      ownerId: USER,
      managementFeePct: 15,
    })

    // Two awaited queries in order (the pool has no transaction helper).
    expect(mockQuery).toHaveBeenCalledTimes(2)
    expect(sqlAt(0)).toContain('UPDATE client_billing_profiles')
    expect(sqlAt(0)).toContain('SET active = false')
    expect(sqlAt(0)).toContain('AND active')
    expect(paramsAt(0)).toEqual([TENANT, CUSTOMER])

    expect(sqlAt(1)).toContain('INSERT INTO client_billing_profiles')
    expect(sqlAt(1)).toContain('RETURNING *')
    expect(paramsAt(1)[0]).toBe(TENANT)
    expect(paramsAt(1)[1]).toBe(CUSTOMER)
    expect(paramsAt(1)[3]).toBe('pct_of_revenue') // feeModel default
    expect(paramsAt(1)[6]).toBe('USD')            // currency default
    expect(paramsAt(1)[7]).toBe('monthly')        // billingPeriod default
    expect(paramsAt(1)[8]).toBe(true)             // billOnSponsorship default
    expect(paramsAt(1)[10]).toBeNull()            // validFrom omitted -> DB default

    // decimal -> number coercion on the way out.
    expect(row.management_fee_pct).toBe(15)
    expect(row.flat_amount).toBeNull()
    expect(row.active).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  listBillingProfiles visibility
// ═══════════════════════════════════════════════════════════════════════════

describe('billing – listBillingProfiles', () => {
  it('admin sees all tenant rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [rawProfileRow()] })

    const { listBillingProfiles } = await import('../../../src/db/billing')
    const rows = await listBillingProfiles(ADMIN_CTX)

    expect(rows[0]!.management_fee_pct).toBe(15)
    expect(sqlAt()).toContain('FROM client_billing_profiles p')
    expect(sqlAt()).toContain('p.tenant_id = $1')
    expect(sqlAt()).not.toContain('team_member_ids')
    expect(sqlAt()).toContain('ORDER BY p.created_at DESC')
    expect(paramsAt()).toEqual([TENANT, 50])
  })

  it('non-admin visibility uses the customers ownership subquery', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { listBillingProfiles } = await import('../../../src/db/billing')
    await listBillingProfiles(USER_CTX, { customerId: CUSTOMER, active: false })

    expect(sqlAt()).toContain('p.customer_id IN')
    expect(sqlAt()).toContain('SELECT id FROM customers')
    expect(sqlAt()).toContain('owner_id = $2')
    expect(sqlAt()).toContain('team_member_ids')
    expect(sqlAt()).toContain('p.customer_id = $3')
    expect(sqlAt()).toContain('p.active = $4')
    expect(paramsAt()).toEqual([TENANT, USER, CUSTOMER, false, 50])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  generateInvoice
// ═══════════════════════════════════════════════════════════════════════════

describe('billing – generateInvoice', () => {
  /** Route the raw billing queries against canned rows (video layer is mocked). */
  function routeDb(
    profileRows: unknown[],
    sponsorshipTotal: string,
    invoiceCount: number,
    insertRows: unknown[],
  ): void {
    mockQuery.mockImplementation((sql: unknown) => {
      const text = String(sql)
      if (text.includes('FROM client_billing_profiles')) return { rows: profileRows }
      if (text.includes('FROM sponsorship_income')) return { rows: [{ total: sponsorshipTotal }] }
      if (text.includes('count(*)::int AS count FROM billing_invoices')) return { rows: [{ count: invoiceCount }] }
      if (text.includes('INSERT INTO billing_invoices')) return { rows: insertRows }
      throw new Error(`unexpected SQL in test: ${text}`)
    })
  }

  it('produces a deterministic draft invoice from aggregates + the fee math', async () => {
    routeDb([rawProfileRow({ management_fee_pct: '10.000' })], '500.00', 0, [
      rawInvoiceRow({
        platform_revenue: '1000.00',
        sponsorship_revenue: '500.00',
        gross_revenue: '1500.00',
        fee_pct: '10.000',
        computed_amount: '150.00',
        invoice_number: 'INV-2026-0001',
        line_items: [
          { label: 'platform_revenue', amount: 1000, currency: 'USD' },
          { label: 'sponsorship_revenue', amount: 500, currency: 'USD' },
          { label: 'billing_basis', amount: 1500, currency: 'USD' },
          { label: 'management_fee_pct', amount: 150, pct: 10, currency: 'USD' },
          { label: 'total_fee', amount: 150, currency: 'USD' },
        ],
      }),
    ])
    videoDb.listVideoChannels.mockResolvedValueOnce([
      { id: 'ch1', tenant_id: TENANT, customer_id: CUSTOMER, ownership: 'client' },
    ])
    // Decimals arrive as strings from pg even though VideoEarning types them number.
    videoDb.getVideoEarningsByChannel.mockResolvedValueOnce([
      { estimated_earnings: '400.00' },
      { estimated_earnings: '600.00' },
      { estimated_earnings: null },
    ])

    const { generateInvoice } = await import('../../../src/db/billing')
    const result = await generateInvoice(ADMIN_CTX, {
      customerId: CUSTOMER,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const inv = result.invoice
    expect(inv.status).toBe('draft')
    expect(inv.platform_revenue).toBe(1000)
    expect(inv.sponsorship_revenue).toBe(500)
    expect(inv.gross_revenue).toBe(1500)
    expect(inv.computed_amount).toBe(150)
    expect(inv.fee_pct).toBe(10)
    expect(inv.invoice_number).toBe('INV-2026-0001')
    expect(inv.channel_ids).toEqual(['ch1'])
    expect(inv.line_items).toHaveLength(5)

    // Channels are looked up as client-owned for this customer.
    expect(videoDb.listVideoChannels).toHaveBeenCalledWith(TENANT, {
      customerId: CUSTOMER,
      ownership: 'client',
    })
    expect(videoDb.getVideoEarningsByChannel).toHaveBeenCalledWith(TENANT, 'ch1', {
      start: '2026-01-01',
      end: '2026-01-31',
    })

    // The regen guard: money may only be overwritten while the row is a draft.
    const insert = callWith('INSERT INTO billing_invoices')
    expect(insert.sql).toContain('ON CONFLICT (tenant_id, customer_id, period_start, period_end) DO UPDATE SET')
    expect(insert.sql).toContain("WHERE billing_invoices.status = 'draft'")
    expect(insert.sql).toContain("fee_model")
    expect(insert.params[0]).toBe(TENANT)
    expect(insert.params[1]).toBe(CUSTOMER)
    expect(insert.params[2]).toBe('bp1') // billing_profile_id
    expect(insert.params[6]).toEqual(['ch1']) // channel_ids (uuid[])
    expect(insert.params[7]).toBe(1000) // platform_revenue
    expect(insert.params[8]).toBe(500) // sponsorship_revenue
    expect(insert.params[9]).toBe(1500) // gross_revenue
    expect(insert.params[11]).toBe('pct_of_revenue')
    expect(insert.params[14]).toBe(150) // computed_amount
    expect(insert.params[15]).toContain('total_fee') // line_items JSON
    expect(insert.params[16]).toBe('INV-2026-0001')
  })

  it('returns no-active-profile without touching the video layer', async () => {
    routeDb([], '0', 0, [])

    const { generateInvoice } = await import('../../../src/db/billing')
    const result = await generateInvoice(ADMIN_CTX, {
      customerId: CUSTOMER,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
    })

    expect(result).toEqual({ ok: false, reason: 'no-active-profile' })
    expect(videoDb.listVideoChannels).not.toHaveBeenCalled()
  })

  it('returns no-channels when the customer owns no client channels', async () => {
    routeDb([rawProfileRow()], '0', 0, [])
    videoDb.listVideoChannels.mockResolvedValueOnce([])

    const { generateInvoice } = await import('../../../src/db/billing')
    const result = await generateInvoice(ADMIN_CTX, {
      customerId: CUSTOMER,
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
    })

    expect(result).toEqual({ ok: false, reason: 'no-channels' })
    expect(videoDb.getVideoEarningsByChannel).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  setInvoiceStatus (local lifecycle)
// ═══════════════════════════════════════════════════════════════════════════

describe('billing – setInvoiceStatus', () => {
  it('rejects an illegal transition (draft -> issued) without writing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'draft' }] }) // read

    const { setInvoiceStatus } = await import('../../../src/db/billing')
    const result = await setInvoiceStatus(ADMIN_CTX, 'bi1', 'issued')

    expect(result).toBeNull()
    expect(mockQuery).toHaveBeenCalledTimes(1) // read only, no UPDATE
  })

  it('returns null when the row is missing or hidden', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { setInvoiceStatus } = await import('../../../src/db/billing')
    const result = await setInvoiceStatus(USER_CTX, 'bi1', 'approved')

    expect(result).toBeNull()
    expect(mockQuery).toHaveBeenCalledTimes(1)
    // non-admin: id lands after the two visibility params → $3.
    expect(sqlAt()).toContain('i.id = $3')
    expect(sqlAt()).toContain('team_member_ids')
  })

  it('allows draft -> approved', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ status: 'draft' }] })
      .mockResolvedValueOnce({ rows: [rawInvoiceRow({ status: 'approved' })] })

    const { setInvoiceStatus } = await import('../../../src/db/billing')
    const result = await setInvoiceStatus(ADMIN_CTX, 'bi1', 'approved')

    expect(result).not.toBeNull()
    expect(result!.status).toBe('approved')
    const update = callWith('UPDATE billing_invoices')
    expect(update.sql).toContain('SET status = $2')
    expect(update.sql).toContain('updated_at = now()')
    expect(update.sql).not.toContain('issued_at')
    expect(update.sql).toContain('i.id = $3')
    expect(update.params).toEqual([TENANT, 'approved', 'bi1'])
  })

  it('allows approved -> issued and stamps issued_at', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ status: 'approved' }] })
      .mockResolvedValueOnce({ rows: [rawInvoiceRow({ status: 'issued', issued_at: '2026-02-01T00:00:00Z' })] })

    const { setInvoiceStatus } = await import('../../../src/db/billing')
    const result = await setInvoiceStatus(ADMIN_CTX, 'bi1', 'issued')

    expect(result).not.toBeNull()
    expect(result!.status).toBe('issued')
    expect(result!.issued_at).toBe('2026-02-01T00:00:00Z')
    const update = callWith('UPDATE billing_invoices')
    expect(update.sql).toContain('SET status = $2')
    expect(update.sql).toContain('issued_at = now()')
  })

  it('rejects a terminal row (issued -> approved)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'issued' }] })

    const { setInvoiceStatus } = await import('../../../src/db/billing')
    expect(await setInvoiceStatus(ADMIN_CTX, 'bi1', 'approved')).toBeNull()
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })
})
