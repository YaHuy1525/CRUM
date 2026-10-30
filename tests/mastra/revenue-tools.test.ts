import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isValidationError, type ValidationError } from '@mastra/core/tools'

// Mock every DB layer the revenue tools touch so no real module (pg client,
// env) loads in the unit project. vi.mock is hoisted above the import below.
const mocks = vi.hoisted(() => ({
  listVideoChannels: vi.fn(),
  sumEarningsByChannel: vi.fn(),
  sumRevenueTotals: vi.fn(),
  countOpenRevenueAlerts: vi.fn(),
  listInvoices: vi.fn(),
  listRevenueAlerts: vi.fn(),
}))

vi.mock('../../src/db/video-queries', () => ({
  listVideoChannels: mocks.listVideoChannels,
}))
vi.mock('../../src/db/revenue-queries', () => ({
  sumEarningsByChannel: mocks.sumEarningsByChannel,
  sumRevenueTotals: mocks.sumRevenueTotals,
  countOpenRevenueAlerts: mocks.countOpenRevenueAlerts,
}))
vi.mock('../../src/db/billing', () => ({
  listInvoices: mocks.listInvoices,
}))
vi.mock('../../src/db/alerts', () => ({
  listRevenueAlerts: mocks.listRevenueAlerts,
}))

import {
  listChannelsTool,
  sumEarningsTool,
  revenueTotalsTool,
  listInvoicesTool,
  listAlertsTool,
} from '../../src/mastra/tools/revenue'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'

function fakeContext() {
  return {
    requestContext: { all: { tenantId: TENANT_ID, userId: USER_ID, userRole: 'admin' } },
    observe: {
      span: (_name: string, fn: () => Promise<unknown>) => fn(),
    },
  }
}

// The shape every createTool() result has here. `execute` is written as method
// shorthand on purpose: parameter types are then checked bivariantly, so a real
// Tool (whose execute takes the schema input and the Mastra context) satisfies
// it without any cast, while the harness still calls it with unknowns. The
// `this: void` annotation states the one thing callExecute relies on: it detaches
// execute from the tool object and calls it standalone.
type CallableTool = {
  id: string
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
  execute?(this: void, input: unknown, context: unknown): Promise<unknown>
}

// What a tool's execute() resolves to. Mastra types the wrapper as
// `Promise<TOutput | ValidationError | void>`; callExecute below never lets the
// last two reach a test, so the tests only see the output-schema payload type.
type ToolPayload<T extends CallableTool> = T extends {
  execute?: (...args: never[]) => Promise<infer R>
}
  ? Exclude<Awaited<R>, ValidationError | void>
  : never

// Mastra 1.x Tool instances expose a validated `execute(input, context)`
// wrapper; if a future version stops exposing it, this throws with a clear
// message instead of a cryptic type error.
async function callExecute<T extends CallableTool>(
  tool: T,
  input: unknown,
): Promise<ToolPayload<T>> {
  const execute: CallableTool['execute'] = tool.execute
  if (typeof execute !== 'function') {
    throw new Error(`tool ${tool.id} does not expose a callable execute()`)
  }
  const out: unknown = await execute(input, fakeContext())
  // The wrapper returns a ValidationError object (never throws) on failure.
  if (isValidationError(out)) {
    throw new Error(`execute returned a validation error: ${out.message}`)
  }
  return out as ToolPayload<T>
}

// noUncheckedIndexedAccess-safe accessor for the first recorded call.
function firstCall(fn: { mock: { calls: unknown[][] } }): unknown[] {
  const call = fn.mock.calls[0]
  if (!call) throw new Error('mock was not called')
  return call
}

// Same contract as firstCall(), for the row-indexing assertions below: a result
// that is shorter than the test expects fails loudly instead of type-softly.
function rowAt<T>(rows: readonly T[], index: number): T {
  const row = rows[index]
  if (row === undefined) throw new Error(`expected a row at index ${index}, got ${rows.length}`)
  return row
}

const ALL_TOOLS: Array<[string, CallableTool]> = [
  ['revenue.list_channels', listChannelsTool],
  ['revenue.sum_earnings', sumEarningsTool],
  ['revenue.revenue_totals', revenueTotalsTool],
  ['revenue.list_invoices', listInvoicesTool],
  ['revenue.list_alerts', listAlertsTool],
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('revenue read-tools: metadata (baseline, knowledge-tool.test.ts style)', () => {
  it.each(ALL_TOOLS)('%s is defined with schemas and a tenant-scoped read-only description', (id, tool) => {
    expect(tool).toBeDefined()
    expect(tool.id).toBe(id)
    expect(tool.inputSchema).toBeDefined()
    expect(tool.outputSchema).toBeDefined()
    expect(tool.description).toContain('tenant')
    expect(tool.description).toMatch(/read-only|cannot mutate/i)
  })
})

describe('listChannelsTool execute', () => {
  it('maps db rows and sets has_oauth_token only when oauth_token_id is present', async () => {
    mocks.listVideoChannels.mockResolvedValue([
      {
        id: 'ch-with-token',
        tenant_id: TENANT_ID,
        platform: 'youtube',
        platform_channel_id: 'UC1',
        channel_name: 'Main Channel',
        channel_url: null,
        customer_id: null,
        contact_id: null,
        ownership: 'self',
        status: 'active',
        oauth_token_id: 'tok-1',
        // pg returns timestamptz as a Date, not a string. The tool must serialise
        // it: a Date reaching the z.string() output schema used to reject the
        // whole call for any channel that had ever synced (2026-10-30).
        last_sync_at: new Date('2026-10-01T00:00:00Z'),
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'ch-without-token',
        tenant_id: TENANT_ID,
        platform: 'tiktok',
        platform_channel_id: 'tt-2',
        channel_name: null,
        channel_url: null,
        customer_id: 'cust-2',
        contact_id: null,
        ownership: 'client',
        status: 'disconnected',
        oauth_token_id: null,
        last_sync_at: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ])

    const out = await callExecute(listChannelsTool, { platform: 'youtube' })

    // tenantId goes as the first arg (video CRUD is tenant-scoped, not context-scoped)
    expect(mocks.listVideoChannels).toHaveBeenCalledTimes(1)
    expect(firstCall(mocks.listVideoChannels)[0]).toBe(TENANT_ID)
    expect(firstCall(mocks.listVideoChannels)[1]).toMatchObject({ platform: 'youtube' })

    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      id: 'ch-with-token',
      channel_name: 'Main Channel',
      platform: 'youtube',
      ownership: 'self',
      status: 'active',
      customer_id: null,
      last_sync_at: '2026-10-01T00:00:00.000Z',
      has_oauth_token: true,
    })
    expect(rowAt(out, 1).has_oauth_token).toBe(false)
    // token id itself must never leak into the tool output
    expect(JSON.stringify(out)).not.toContain('tok-1')
    expect(JSON.stringify(out)).not.toContain(TENANT_ID)
  })
})

describe('sumEarningsTool execute', () => {
  it('passes tenantId + date range and keeps money as decimal strings', async () => {
    mocks.sumEarningsByChannel.mockResolvedValue([
      {
        channel_id: 'ch1',
        channel_name: 'Main Channel',
        platform: 'youtube',
        ownership: 'self',
        status: 'active',
        currency: 'USD',
        total_revenue: '123.45',
        total_views: 900,
        last_sync_at: '2026-10-01T00:00:00Z',
      },
    ])

    const out = await callExecute(sumEarningsTool, { from: '2026-09-01', to: '2026-09-30' })

    expect(mocks.sumEarningsByChannel).toHaveBeenCalledWith(TENANT_ID, {
      from: '2026-09-01',
      to: '2026-09-30',
    })
    expect(out).toHaveLength(1)
    expect(rowAt(out, 0).total_revenue).toBe('123.45')
    expect(typeof rowAt(out, 0).total_revenue).toBe('string')
    expect(rowAt(out, 0).total_views).toBe(900)
  })
})

describe('revenueTotalsTool execute', () => {
  it('returns the tenant roll-up unchanged (money stays strings)', async () => {
    mocks.sumRevenueTotals.mockResolvedValue({
      currency: 'USD',
      platform_revenue: '1000.50',
      sponsorship_revenue: '250.00',
      grand_total: '1250.50',
      channels_with_earnings: 3,
    })

    const out = await callExecute(revenueTotalsTool, {})

    expect(mocks.sumRevenueTotals).toHaveBeenCalledWith(TENANT_ID, {
      from: undefined,
      to: undefined,
    })
    expect(out).toEqual({
      currency: 'USD',
      platform_revenue: '1000.50',
      sponsorship_revenue: '250.00',
      grand_total: '1250.50',
      channels_with_earnings: 3,
    })
  })
})

describe('listInvoicesTool execute', () => {
  it('passes the FULL request context (not tenantId) and maps number money fields', async () => {
    mocks.listInvoices.mockResolvedValue([
      {
        id: 'inv-1',
        tenant_id: TENANT_ID,
        customer_id: 'cust-1',
        billing_profile_id: null,
        owner_id: USER_ID,
        // A `date` column arrives as a Date built at LOCAL midnight. Rendering it
        // with toISOString() would report 2026-08-31 on a UTC+10 server, so the
        // tool renders the calendar day from the Date's own parts.
        period_start: new Date(2026, 8, 1),
        period_end: new Date(2026, 8, 30),
        channel_ids: [],
        platform_revenue: 1000.5,
        sponsorship_revenue: 250,
        gross_revenue: 1250.5,
        currency: 'USD',
        fee_model: 'pct_of_revenue',
        fee_pct: 10,
        fee_flat_amount: null,
        computed_amount: 125.05,
        line_items: [],
        status: 'issued',
        invoice_number: 'INV-2026-09',
        issued_at: null,
        notes: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
    ])

    const out = await callExecute(listInvoicesTool, { status: 'issued' })

    // listInvoices' FIRST param is the context object, not a bare tenantId.
    const [ctxArg, filtersArg] = firstCall(mocks.listInvoices)
    expect(ctxArg).toMatchObject({ tenantId: TENANT_ID, userId: USER_ID, userRole: 'admin' })
    expect(filtersArg).toMatchObject({ status: 'issued' })

    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      id: 'inv-1',
      customer_id: 'cust-1',
      period_start: '2026-09-01',
      period_end: '2026-09-30',
      currency: 'USD',
      computed_amount: 125.05,
      gross_revenue: 1250.5,
      fee_model: 'pct_of_revenue',
      status: 'issued',
      invoice_number: 'INV-2026-09',
    })
    expect(typeof rowAt(out, 0).computed_amount).toBe('number')
  })
})

describe('listAlertsTool execute', () => {
  it('passes the FULL request context and maps alert rows', async () => {
    const channelId = '33333333-3333-4333-8333-333333333333'
    mocks.listRevenueAlerts.mockResolvedValue([
      {
        id: 'al-1',
        tenant_id: TENANT_ID,
        channel_id: channelId,
        customer_id: null,
        owner_id: USER_ID,
        kind: 'revenue_drop',
        severity: 'warning',
        message: 'YouTube earnings dropped 40% week over week',
        metrics: { drop_pct: 40 },
        dedup_key: 'ch1:revenue_drop:2026-10-01',
        status: 'open',
        acknowledged_at: null,
        created_at: new Date('2026-10-01T00:00:00Z'),
        updated_at: '2026-10-01T00:00:00Z',
      },
    ])

    const out = await callExecute(listAlertsTool, { status: 'open', channelId })

    const [ctxArg, filtersArg] = firstCall(mocks.listRevenueAlerts)
    expect(ctxArg).toMatchObject({ tenantId: TENANT_ID, userId: USER_ID, userRole: 'admin' })
    expect(filtersArg).toMatchObject({
      status: 'open',
      channelId,
    })

    expect(out).toEqual([
      {
        id: 'al-1',
        channel_id: channelId,
        customer_id: null,
        kind: 'revenue_drop',
        severity: 'warning',
        message: 'YouTube earnings dropped 40% week over week',
        status: 'open',
        created_at: '2026-10-01T00:00:00.000Z',
      },
    ])
  })
})
