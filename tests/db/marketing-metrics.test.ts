// tests/db/marketing-metrics.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockPool = { query: mockQuery, end: vi.fn() }

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://test:test@localhost:5432/testdb', NODE_ENV: 'test' }),
}))

const TENANT = '11111111-1111-4111-8111-111111111111'
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const CAMPAIGN_ID = '23842653876'

function calls(fragment: string): Array<{ sql: string; params: unknown[] }> {
  return (mockQuery.mock.calls as unknown[][])
    .filter((call) => (call[0] as string).includes(fragment))
    .map((call) => ({ sql: call[0] as string, params: (call[1] ?? []) as unknown[] }))
}

async function load() {
  return await import('../../src/db/marketing-metrics')
}

beforeEach(() => {
  vi.resetModules()
  mockQuery.mockReset()
})

describe('insertSnapshot', () => {
  it('inserts a row with all required fields into marketing_metrics_snapshots', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tenant_id: TENANT,
          bundle_id: BUNDLE,
          campaign_external_id: CAMPAIGN_ID,
          window_start: '2026-10-24T00:00:00.000Z',
          window_end: '2026-10-31T00:00:00.000Z',
          metrics: { data: [] },
          created_at: '2026-10-31T09:00:00.000Z',
        },
      ],
    })

    const { insertSnapshot } = await load()
    const row = await insertSnapshot(
      TENANT,
      BUNDLE,
      CAMPAIGN_ID,
      '2026-10-24T00:00:00.000Z',
      '2026-10-31T00:00:00.000Z',
      { data: [{ impressions: '100' }] },
    )

    const [call] = calls('INSERT INTO marketing_metrics_snapshots')
    expect(call).toBeDefined()
    expect(call!.sql).toContain('tenant_id')
    expect(call!.sql).toContain('bundle_id')
    expect(call!.sql).toContain('campaign_external_id')
    expect(call!.sql).toContain('window_start')
    expect(call!.sql).toContain('window_end')
    expect(call!.sql).toContain('metrics')
    expect(call!.sql).toContain('RETURNING')
    expect(call!.params).toEqual([
      TENANT,
      BUNDLE,
      CAMPAIGN_ID,
      '2026-10-24T00:00:00.000Z',
      '2026-10-31T00:00:00.000Z',
      JSON.stringify({ data: [{ impressions: '100' }] }),
    ])
    expect(row.tenantId).toBe(TENANT)
    expect(row.campaignExternalId).toBe(CAMPAIGN_ID)
  })

  it('accepts Date objects for window boundaries', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tenant_id: TENANT,
          bundle_id: BUNDLE,
          campaign_external_id: CAMPAIGN_ID,
          window_start: '2026-10-24T00:00:00.000Z',
          window_end: '2026-10-31T00:00:00.000Z',
          metrics: {},
          created_at: '2026-10-31T09:00:00.000Z',
        },
      ],
    })

    const { insertSnapshot } = await load()
    await insertSnapshot(
      TENANT,
      BUNDLE,
      CAMPAIGN_ID,
      new Date('2026-10-24T00:00:00.000Z'),
      new Date('2026-10-31T00:00:00.000Z'),
      {},
    )

    const [call] = calls('INSERT INTO marketing_metrics_snapshots')
    expect(call!.params[3]).toBe('2026-10-24T00:00:00.000Z')
    expect(call!.params[4]).toBe('2026-10-31T00:00:00.000Z')
  })
})

describe('listSnapshots', () => {
  it('queries snapshots for a campaign, ordered by window_start DESC', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tenant_id: TENANT,
          bundle_id: BUNDLE,
          campaign_external_id: CAMPAIGN_ID,
          window_start: '2026-10-31T00:00:00.000Z',
          window_end: '2026-10-31T00:00:00.000Z',
          metrics: { data: [] },
          created_at: '2026-10-31T09:00:00.000Z',
        },
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          tenant_id: TENANT,
          bundle_id: BUNDLE,
          campaign_external_id: CAMPAIGN_ID,
          window_start: '2026-10-24T00:00:00.000Z',
          window_end: '2026-10-24T00:00:00.000Z',
          metrics: { data: [] },
          created_at: '2026-10-24T09:00:00.000Z',
        },
      ],
    })

    const { listSnapshots } = await load()
    const rows = await listSnapshots(TENANT, CAMPAIGN_ID)

    const [call] = calls('FROM marketing_metrics_snapshots')
    expect(call!.sql).toContain('tenant_id = $1')
    expect(call!.sql).toContain('campaign_external_id = $2')
    expect(call!.sql).toContain('ORDER BY window_start DESC')
    expect(call!.params).toEqual([TENANT, CAMPAIGN_ID])
    expect(rows).toHaveLength(2)
    expect(rows[0]!.windowStart).toBe('2026-10-31T00:00:00.000Z')
  })

  it('applies a LIMIT when provided', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const { listSnapshots } = await load()
    await listSnapshots(TENANT, CAMPAIGN_ID, 5)

    const [call] = calls('FROM marketing_metrics_snapshots')
    expect(call!.sql).toContain('LIMIT $3')
    expect(call!.params).toEqual([TENANT, CAMPAIGN_ID, 5])
  })

  it('returns an empty array when no snapshots match', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const { listSnapshots } = await load()
    const rows = await listSnapshots(TENANT, 'nonexistent-campaign')

    expect(rows).toEqual([])
  })
})

describe('listRecentSnapshots', () => {
  it('queries all snapshots within the past N days for a tenant', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tenant_id: TENANT,
          bundle_id: BUNDLE,
          campaign_external_id: CAMPAIGN_ID,
          window_start: '2026-10-28T00:00:00.000Z',
          window_end: '2026-10-28T00:00:00.000Z',
          metrics: { data: [] },
          created_at: '2026-10-28T09:00:00.000Z',
        },
      ],
    })

    const { listRecentSnapshots } = await load()
    const rows = await listRecentSnapshots(TENANT, 7)

    const [call] = calls('FROM marketing_metrics_snapshots')
    expect(call!.sql).toContain('tenant_id = $1')
    expect(call!.sql).toContain('window_start >=')
    expect(call!.sql).toContain("' days')::interval")
    expect(call!.params).toEqual([TENANT, 7])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.campaignExternalId).toBe(CAMPAIGN_ID)
  })

  it('returns an empty array when no recent snapshots exist', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const { listRecentSnapshots } = await load()
    const rows = await listRecentSnapshots(TENANT, 7)

    expect(rows).toEqual([])
  })
})
