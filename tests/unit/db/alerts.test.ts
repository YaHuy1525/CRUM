import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'

// ── shared mock plumbing (mirrors tests/unit/db/sponsorship.test.ts) ────────
// The whole module goes through getDbClient().query, so a stubbed Pool is
// enough — no live DB required.  detectRevenueAlerts is unit-tested with
// ./video-queries itself stubbed out, so detection math is isolated from SQL.

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

const { mockListVideoChannels, mockGetVideoEarningsByChannel } = vi.hoisted(() => ({
  mockListVideoChannels: vi.fn(),
  mockGetVideoEarningsByChannel: vi.fn(),
}))

vi.mock('../../../src/db/video-queries', () => ({
  listVideoChannels: mockListVideoChannels,
  getVideoEarningsByChannel: mockGetVideoEarningsByChannel,
}))

const TENANT = 'tenant-1'
const USER = 'user-1'
const ADMIN_CTX = { tenantId: TENANT, userId: USER, userRole: 'admin' as const }
const USER_CTX = { tenantId: TENANT, userId: USER, userRole: 'user' as const }

function sqlAt(callIndex = 0): string {
  return mockQuery.mock.calls[callIndex]![0] as string
}
function paramsAt(callIndex = 0): unknown[] {
  return mockQuery.mock.calls[callIndex]![1] as unknown[]
}

/** Only the mock-query calls that run the alert INSERT. */
function insertAlertCalls(): unknown[][] {
  return mockQuery.mock.calls.filter(
    (call) => (call[0] as string).includes('INSERT INTO revenue_alerts'),
  )
}

/** A fully-populated raw row (metrics is jsonb, so already an object). */
function rawAlertRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'al1',
    tenant_id: TENANT,
    channel_id: 'ch1',
    customer_id: 'cust1',
    owner_id: USER,
    kind: 'revenue_drop',
    severity: 'warning',
    message: 'Revenue fell 50% on channel TechTube',
    metrics: { current: 100, prior: 200, pctChange: -0.5 },
    dedup_key: 'ch1:2026-06-15',
    status: 'open',
    acknowledged_at: null,
    created_at: '2026-06-15T00:00:00Z',
    updated_at: '2026-06-15T00:00:00Z',
    ...overrides,
  }
}

function channelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ch1',
    tenant_id: TENANT,
    platform: 'youtube',
    platform_channel_id: 'UC1',
    channel_name: 'TechTube',
    channel_url: null,
    customer_id: 'cust1',
    contact_id: null,
    ownership: 'self',
    status: 'active',
    oauth_token_id: null,
    last_sync_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

/** Estimated earnings as a decimal-style STRING, exactly as pg returns it. */
function earningRow(date: string, estimated: string | number | null) {
  return {
    id: `ve-${date}`,
    tenant_id: TENANT,
    channel_id: 'ch1',
    date,
    estimated_earnings: estimated,
    currency: 'USD',
    ad_revenue: null,
    cpm: null,
    rpm: null,
    views_count: null,
    metadata: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

// A deterministic 'now' → current window [2026-06-09..2026-06-15],
// prior window [2026-06-02..2026-06-08].
const NOW = new Date('2026-06-15T12:34:56Z')

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
  mockListVideoChannels.mockReset()
  mockGetVideoEarningsByChannel.mockReset()
})

// ═══════════════════════════════════════════════════════════════════════════
//  insertRevenueAlert
// ═══════════════════════════════════════════════════════════════════════════

describe('alerts – insertRevenueAlert', () => {
  it('inserts a fresh row and reports deduped:false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'al1' }] })

    const { insertRevenueAlert } = await import('../../../src/db/alerts')
    const result = await insertRevenueAlert(TENANT, {
      channelId: 'ch1',
      kind: 'revenue_drop',
      message: 'Revenue fell 50% on channel TechTube',
      dedupKey: 'ch1:2026-06-15',
    })

    expect(result).toEqual({ id: 'al1', deduped: false })
    const sql = sqlAt()
    expect(sql).toContain('INSERT INTO revenue_alerts')
    expect(sql).toContain(
      "ON CONFLICT (tenant_id, kind, dedup_key) WHERE status = 'open'",
    )
    expect(sql).toContain('DO NOTHING')
    expect(sql).toContain('RETURNING id')

    const p = paramsAt()
    expect(p[0]).toBe(TENANT)
    expect(p[1]).toBe('ch1')          // channel_id
    expect(p[2]).toBeNull()           // customer_id default
    expect(p[4]).toBe('revenue_drop')
    expect(p[5]).toBe('info')         // severity default
    expect(p[6]).toBe('Revenue fell 50% on channel TechTube')
    expect(p[7]).toBe('{}')           // metrics default
    expect(p[8]).toBe('ch1:2026-06-15')
    // Only ONE query ran (no follow-up lookup on a clean insert).
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('passes every provided field through as parameters', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'al2' }] })

    const { insertRevenueAlert } = await import('../../../src/db/alerts')
    const result = await insertRevenueAlert(TENANT, {
      channelId: 'ch1',
      customerId: 'cust1',
      ownerId: 'o1',
      kind: 'revenue_spike',
      severity: 'critical',
      message: 'Spike',
      metrics: { current: 3, prior: 1 },
      dedupKey: 'ch1:2026-06-15',
    })

    expect(result).toEqual({ id: 'al2', deduped: false })
    const p = paramsAt()
    expect(p[2]).toBe('cust1')
    expect(p[3]).toBe('o1')
    expect(p[4]).toBe('revenue_spike')
    expect(p[5]).toBe('critical')
    expect(p[7]).toBe('{"current":3,"prior":1}')
  })

  it('returns the still-open duplicate with deduped:true when ON CONFLICT swallows the insert', async () => {
    // 1st query: INSERT ... DO NOTHING returns no row.
    mockQuery.mockResolvedValueOnce({ rows: [] })
    // 2nd query: the follow-up lookup finds the open duplicate.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing' }] })

    const { insertRevenueAlert } = await import('../../../src/db/alerts')
    const result = await insertRevenueAlert(TENANT, {
      kind: 'revenue_drop',
      message: 'dup',
      dedupKey: 'ch1:2026-06-15',
    })

    expect(result).toEqual({ id: 'existing', deduped: true })
    expect(mockQuery).toHaveBeenCalledTimes(2)
    const lookup = sqlAt(1)
    expect(lookup).toContain('SELECT a.id FROM revenue_alerts a')
    expect(lookup).toContain("a.status = 'open'")
    expect(lookup).toContain('a.tenant_id = $1 AND a.kind = $2 AND a.dedup_key = $3')
    expect(paramsAt(1)).toEqual([TENANT, 'revenue_drop', 'ch1:2026-06-15'])
  })

  it('throws when the conflict row vanished before the lookup', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { insertRevenueAlert } = await import('../../../src/db/alerts')
    await expect(
      insertRevenueAlert(TENANT, { kind: 'sync_failure', message: 'x', dedupKey: 'k' }),
    ).rejects.toThrow(/no open duplicate/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  listRevenueAlerts
// ═══════════════════════════════════════════════════════════════════════════

describe('alerts – listRevenueAlerts', () => {
  it('admin sees all tenant rows, newest first, default limit 50', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [rawAlertRow()] })

    const { listRevenueAlerts } = await import('../../../src/db/alerts')
    const rows = await listRevenueAlerts(ADMIN_CTX)

    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('revenue_drop')
    expect(rows[0]!.metrics).toEqual({ current: 100, prior: 200, pctChange: -0.5 })

    const sql = sqlAt()
    expect(sql).toContain('FROM revenue_alerts a')
    expect(sql).toContain('a.tenant_id = $1')
    expect(sql).not.toContain('owner_id')
    expect(sql).toContain('ORDER BY a.created_at DESC, a.id DESC')
    expect(sql).toContain('LIMIT $2')
    expect(paramsAt()).toEqual([TENANT, 50])
  })

  it('non-admin visibility covers tenant-wide rows, owned customers and channel customers', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { listRevenueAlerts } = await import('../../../src/db/alerts')
    await listRevenueAlerts(USER_CTX)

    const sql = sqlAt()
    expect(sql).toContain('a.owner_id = $2')
    expect(sql).toContain('(a.customer_id IS NULL AND a.channel_id IS NULL)')
    expect(sql).toContain('a.customer_id IN')
    expect(sql).toContain('SELECT id FROM customers')
    expect(sql).toContain('team_member_ids')
    expect(sql).toContain('SELECT v.id FROM video_channels v')
    expect(sql).toContain('v.customer_id IN')
    expect(sql).toContain('LIMIT $3')
    expect(paramsAt()).toEqual([TENANT, USER, 50])
  })

  it('applies every filter and honours a custom limit', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { listRevenueAlerts } = await import('../../../src/db/alerts')
    await listRevenueAlerts(
      ADMIN_CTX,
      { status: 'acknowledged', kind: 'revenue_spike', channelId: 'ch1', customerId: 'cust1' },
      10,
    )

    const sql = sqlAt()
    expect(sql).toContain('a.status = $2')
    expect(sql).toContain('a.kind = $3')
    expect(sql).toContain('a.channel_id = $4')
    expect(sql).toContain('a.customer_id = $5')
    expect(sql).toContain('LIMIT $6')
    expect(paramsAt()).toEqual([TENANT, 'acknowledged', 'revenue_spike', 'ch1', 'cust1', 10])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  getRevenueAlert
// ═══════════════════════════════════════════════════════════════════════════

describe('alerts – getRevenueAlert', () => {
  it('returns the row when found and visible', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [rawAlertRow()] })

    const { getRevenueAlert } = await import('../../../src/db/alerts')
    const row = await getRevenueAlert(ADMIN_CTX, 'al1')

    expect(row).not.toBeNull()
    expect(row!.id).toBe('al1')
    expect(sqlAt()).toContain('a.id = $2')
    expect(sqlAt()).toContain('a.tenant_id = $1')
    expect(sqlAt()).toContain('LIMIT 1')
    expect(paramsAt()).toEqual([TENANT, 'al1'])
  })

  it('returns null when missing or not visible', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { getRevenueAlert } = await import('../../../src/db/alerts')
    expect(await getRevenueAlert(USER_CTX, 'nope')).toBeNull()
    // non-admin: id lands after the two visibility params → $3.
    expect(sqlAt()).toContain('a.id = $3')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  setRevenueAlertStatus
// ═══════════════════════════════════════════════════════════════════════════

describe('alerts – setRevenueAlertStatus', () => {
  it('stamps acknowledged_at = now() when acknowledging', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [rawAlertRow({ status: 'acknowledged' })] })

    const { setRevenueAlertStatus } = await import('../../../src/db/alerts')
    const row = await setRevenueAlertStatus(ADMIN_CTX, 'al1', 'acknowledged')

    expect(row!.status).toBe('acknowledged')
    const sql = sqlAt()
    expect(sql).toContain('UPDATE revenue_alerts AS a')
    expect(sql).toContain('status = $2')
    expect(sql).toContain('acknowledged_at = now()')
    expect(sql).toContain('updated_at = now()')
    expect(sql).toContain('a.id = $3')
    expect(sql).toContain('RETURNING a.*')
    expect(paramsAt()).toEqual([TENANT, 'acknowledged', 'al1'])
  })

  it('clears acknowledged_at when reopening', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [rawAlertRow({ status: 'open' })] })

    const { setRevenueAlertStatus } = await import('../../../src/db/alerts')
    await setRevenueAlertStatus(ADMIN_CTX, 'al1', 'open')

    expect(sqlAt()).toContain('acknowledged_at = NULL')
  })

  it('leaves acknowledged_at untouched when dismissing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [rawAlertRow({ status: 'dismissed' })] })

    const { setRevenueAlertStatus } = await import('../../../src/db/alerts')
    await setRevenueAlertStatus(ADMIN_CTX, 'al1', 'dismissed')

    expect(sqlAt()).not.toContain('acknowledged_at =')
  })

  it('scopes the update by visibility for non-admins', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { setRevenueAlertStatus } = await import('../../../src/db/alerts')
    const result = await setRevenueAlertStatus(USER_CTX, 'al1', 'dismissed')

    expect(result).toBeNull()
    expect(sqlAt()).toContain('a.owner_id = $2')
    // non-admin: status $3, id $4.
    expect(sqlAt()).toContain('status = $3')
    expect(sqlAt()).toContain('a.id = $4')
    expect(paramsAt()).toEqual([TENANT, USER, 'dismissed', 'al1'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  detectRevenueAlerts
// ═══════════════════════════════════════════════════════════════════════════

describe('alerts – detectRevenueAlerts', () => {
  it('writes one revenue_drop (warning) when the current window falls ~50% vs prior', async () => {
    mockListVideoChannels.mockResolvedValue([channelRow()])
    // prior [2026-06-02..2026-06-08] sums to 200, current [2026-06-09..2026-06-15] sums to 100.
    mockGetVideoEarningsByChannel.mockResolvedValue([
      earningRow('2026-06-14', '40.00'),
      earningRow('2026-06-10', '60.00'),
      earningRow('2026-06-07', '79.50'),
      earningRow('2026-06-03', '120.50'),
    ])
    mockQuery.mockResolvedValue({ rows: [{ id: 'al-drop-1' }] })

    const { detectRevenueAlerts } = await import('../../../src/db/alerts')
    const result = await detectRevenueAlerts(TENANT, { now: NOW })

    expect(result).toEqual({ created: 1, skipped: 0 })
    // Both self and client channels: filters = {}.
    expect(mockListVideoChannels).toHaveBeenCalledWith(TENANT, {})
    // ONE earnings fetch spanning both windows.
    expect(mockGetVideoEarningsByChannel).toHaveBeenCalledTimes(1)
    expect(mockGetVideoEarningsByChannel).toHaveBeenCalledWith(TENANT, 'ch1', {
      start: '2026-06-02',
      end: '2026-06-15',
    })

    const inserts = insertAlertCalls()
    expect(inserts).toHaveLength(1)
    const p = inserts[0]![1] as unknown[]
    expect(p[0]).toBe(TENANT)
    expect(p[1]).toBe('ch1')
    expect(p[2]).toBe('cust1')
    expect(p[4]).toBe('revenue_drop')
    expect(p[5]).toBe('warning')
    expect(p[6]).toBe('Revenue fell 50% on channel TechTube')
    expect(JSON.parse(p[7] as string)).toEqual({
      current: 100,
      prior: 200,
      pctChange: -0.5,
      window: { start: '2026-06-09', end: '2026-06-15' },
    })
    expect(p[8]).toBe('ch1:2026-06-15')
  })

  it('writes a revenue_spike (info) when the current window rises past the spike threshold', async () => {
    mockListVideoChannels.mockResolvedValue([channelRow()])
    mockGetVideoEarningsByChannel.mockResolvedValue([
      earningRow('2026-06-12', '300.00'),
      earningRow('2026-06-05', '100.00'),
    ])
    mockQuery.mockResolvedValue({ rows: [{ id: 'al-spike-1' }] })

    const { detectRevenueAlerts } = await import('../../../src/db/alerts')
    const result = await detectRevenueAlerts(TENANT, { now: NOW })

    expect(result).toEqual({ created: 1, skipped: 0 })
    const inserts = insertAlertCalls()
    expect(inserts).toHaveLength(1)
    const p = inserts[0]![1] as unknown[]
    expect(p[4]).toBe('revenue_spike')
    expect(p[5]).toBe('info')
    expect(p[6]).toBe('Revenue rose 200% on channel TechTube')
    expect(p[8]).toBe('ch1:2026-06-15')
  })

  it('skips a channel with no earnings rows in either window', async () => {
    mockListVideoChannels.mockResolvedValue([channelRow()])
    mockGetVideoEarningsByChannel.mockResolvedValue([])

    const { detectRevenueAlerts } = await import('../../../src/db/alerts')
    const result = await detectRevenueAlerts(TENANT, { now: NOW })

    expect(result).toEqual({ created: 0, skipped: 1 })
    expect(insertAlertCalls()).toHaveLength(0)
  })

  it('skips a channel whose change stays inside both thresholds', async () => {
    mockListVideoChannels.mockResolvedValue([channelRow()])
    mockGetVideoEarningsByChannel.mockResolvedValue([
      earningRow('2026-06-12', '110.00'), // +10%: no drop, no spike
      earningRow('2026-06-05', '100.00'),
    ])

    const { detectRevenueAlerts } = await import('../../../src/db/alerts')
    const result = await detectRevenueAlerts(TENANT, { now: NOW })

    expect(result).toEqual({ created: 0, skipped: 1 })
    expect(insertAlertCalls()).toHaveLength(0)
  })

  it('guards divide-by-zero: prior 0 with positive current counts as a 100% spike', async () => {
    mockListVideoChannels.mockResolvedValue([channelRow()])
    mockGetVideoEarningsByChannel.mockResolvedValue([
      earningRow('2026-06-11', '50.00'),
    ])
    mockQuery.mockResolvedValue({ rows: [{ id: 'al-new-1' }] })

    const { detectRevenueAlerts } = await import('../../../src/db/alerts')
    const result = await detectRevenueAlerts(TENANT, { now: NOW })

    expect(result).toEqual({ created: 1, skipped: 0 })
    const inserts = insertAlertCalls()
    expect(inserts).toHaveLength(1)
    const p = inserts[0]![1] as unknown[]
    expect(p[4]).toBe('revenue_spike')
    expect(JSON.parse(p[7] as string)).toMatchObject({ current: 50, prior: 0, pctChange: 1 })
  })

  it('counts a deduped insert as skipped, not created', async () => {
    mockListVideoChannels.mockResolvedValue([channelRow()])
    mockGetVideoEarningsByChannel.mockResolvedValue([
      earningRow('2026-06-12', '100.00'),
      earningRow('2026-06-05', '200.00'),
    ])
    // INSERT ... DO NOTHING yields no row, then the open-duplicate lookup hits.
    mockQuery.mockResolvedValueOnce({ rows: [] })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing' }] })

    const { detectRevenueAlerts } = await import('../../../src/db/alerts')
    const result = await detectRevenueAlerts(TENANT, { now: NOW })

    expect(result).toEqual({ created: 0, skipped: 1 })
  })

  it('honours custom thresholds', async () => {
    mockListVideoChannels.mockResolvedValue([channelRow()])
    mockGetVideoEarningsByChannel.mockResolvedValue([
      earningRow('2026-06-12', '80.00'),  // -20%
      earningRow('2026-06-05', '100.00'),
    ])

    const { detectRevenueAlerts } = await import('../../../src/db/alerts')
    // Default 0.3 drop threshold → nothing.
    expect(await detectRevenueAlerts(TENANT, { now: NOW })).toEqual({ created: 0, skipped: 1 })
    expect(insertAlertCalls()).toHaveLength(0)

    // A tighter 0.15 drop threshold → the same data alerts.
    mockQuery.mockResolvedValue({ rows: [{ id: 'al-tight-1' }] })
    const result = await detectRevenueAlerts(TENANT, {
      now: NOW,
      thresholds: { dropPct: 0.15, spikePct: 0.5 },
    })
    expect(result).toEqual({ created: 1, skipped: 0 })
  })
})
