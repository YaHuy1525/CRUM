import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'

// ── shared mock plumbing (mirrors tests/unit/db/video-queries.test.ts) ──────
// The whole module goes through getDbClient().query, so a stubbed Pool is
// enough — no live DB required.

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

// A fully-populated raw row with DECIMAL columns as strings (as pg returns).
function rawSponsorshipRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sp1',
    tenant_id: TENANT,
    owner_id: USER,
    channel_id: 'vc1',
    customer_id: 'cust1',
    contact_id: 'ct1',
    brand_name: 'ACME',
    brand_email: 'deals@acme.test',
    deal_type: 'flat',
    amount: '1500.00',
    currency: 'USD',
    deal_date: '2026-01-15',
    period_start: null,
    period_end: null,
    source: 'email',
    source_ref: 'msg-1',
    content_hash: 'h1',
    confidence: '0.850',
    status: 'suggested',
    raw_extract: { a: 1 },
    notes: null,
    created_at: '2026-01-15T00:00:00Z',
    updated_at: '2026-01-15T00:00:00Z',
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  insertSponsorshipSuggestion
// ═══════════════════════════════════════════════════════════════════════════

describe('sponsorship – insertSponsorshipSuggestion', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('inserts with defaults and coerces confidence to a number', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'sp1', status: 'suggested', confidence: '0.850' }],
    })

    const { insertSponsorshipSuggestion } = await import('../../../src/db/sponsorship')
    const result = await insertSponsorshipSuggestion(TENANT, { contentHash: 'h1' })

    expect(result).toEqual({ id: 'sp1', status: 'suggested', confidence: 0.85 })
    const sql = sqlAt()
    expect(sql).toContain('INSERT INTO sponsorship_income')
    expect(sql).toContain('RETURNING id, status, confidence')
    expect(sql).toContain('raw_extract')
    expect(sql).toContain('$19::jsonb')

    const p = paramsAt()
    expect(p[0]).toBe(TENANT)         // tenant_id
    expect(p[9]).toBe('USD')          // currency default
    expect(p[13]).toBe('email')       // source default
    expect(p[15]).toBe('h1')          // content_hash
    expect(p[17]).toBe('suggested')   // status default
    expect(p[18]).toBe('{}')          // raw_extract default
  })

  it('passes every provided field through', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'sp2', status: 'confirmed', confidence: 0.9 }],
    })

    const { insertSponsorshipSuggestion } = await import('../../../src/db/sponsorship')
    const result = await insertSponsorshipSuggestion(TENANT, {
      ownerId: 'o1',
      channelId: 'c1',
      customerId: 'cu1',
      contactId: 'ct1',
      brandName: 'Brand',
      brandEmail: 'b@example.test',
      dealType: 'cpm',
      amount: 2500.75,
      currency: 'EUR',
      dealDate: '2026-02-01',
      periodStart: '2026-02-01',
      periodEnd: '2026-02-28',
      source: 'manual',
      sourceRef: 'ref-9',
      contentHash: 'h2',
      confidence: 0.9,
      status: 'confirmed',
      rawExtract: { k: 'v' },
      notes: 'hi',
    })

    // confidence already numeric stays numeric.
    expect(result).toEqual({ id: 'sp2', status: 'confirmed', confidence: 0.9 })
    const p = paramsAt()
    expect(p[1]).toBe('o1')
    expect(p[2]).toBe('c1')
    expect(p[3]).toBe('cu1')
    expect(p[4]).toBe('ct1')
    expect(p[5]).toBe('Brand')
    expect(p[6]).toBe('b@example.test')
    expect(p[7]).toBe('cpm')
    expect(p[8]).toBe(2500.75)
    expect(p[9]).toBe('EUR')
    expect(p[10]).toBe('2026-02-01')
    expect(p[11]).toBe('2026-02-01')
    expect(p[12]).toBe('2026-02-28')
    expect(p[13]).toBe('manual')
    expect(p[14]).toBe('ref-9')
    expect(p[15]).toBe('h2')
    expect(p[16]).toBe(0.9)
    expect(p[17]).toBe('confirmed')
    expect(p[18]).toBe('{"k":"v"}')
    expect(p[19]).toBe('hi')
  })

  it('de-dups via ON CONFLICT on (tenant_id, content_hash)', async () => {
    // A duplicate scan returns the pre-existing (already confirmed) row.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'existing', status: 'confirmed', confidence: null }],
    })

    const { insertSponsorshipSuggestion } = await import('../../../src/db/sponsorship')
    const result = await insertSponsorshipSuggestion(TENANT, { contentHash: 'h1', status: 'suggested' })

    expect(sqlAt()).toContain('ON CONFLICT (tenant_id, content_hash) DO UPDATE SET updated_at = now()')
    // The conflict path surfaces the stored row, and null confidence stays null.
    expect(result).toEqual({ id: 'existing', status: 'confirmed', confidence: null })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  listSponsorship
// ═══════════════════════════════════════════════════════════════════════════

describe('sponsorship – listSponsorship', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('admin sees all tenant rows and maps decimals to numbers', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [rawSponsorshipRow()] })

    const { listSponsorship } = await import('../../../src/db/sponsorship')
    const rows = await listSponsorship(ADMIN_CTX)

    expect(rows).toHaveLength(1)
    expect(rows[0]!.amount).toBe(1500)
    expect(rows[0]!.confidence).toBe(0.85)
    expect(rows[0]!.status).toBe('suggested')

    const sql = sqlAt()
    expect(sql).toContain('FROM sponsorship_income s')
    expect(sql).toContain('s.tenant_id = $1')
    expect(sql).not.toContain('owner_id')
    expect(sql).toContain('ORDER BY s.created_at DESC, s.id DESC')
    expect(sql).toContain('LIMIT $2')
    expect(paramsAt()).toEqual([TENANT, 50])
  })

  it('non-admin visibility includes owner + customers subquery', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { listSponsorship } = await import('../../../src/db/sponsorship')
    await listSponsorship(USER_CTX)

    const sql = sqlAt()
    expect(sql).toContain('s.owner_id = $2')
    expect(sql).toContain('s.customer_id IS NULL')
    expect(sql).toContain('SELECT id FROM customers')
    expect(sql).toContain('team_member_ids')
    expect(sql).toContain('LIMIT $3')
    expect(paramsAt()).toEqual([TENANT, USER, 50])
  })

  it('applies every filter and honours a custom limit', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { listSponsorship } = await import('../../../src/db/sponsorship')
    await listSponsorship(
      ADMIN_CTX,
      { status: 'confirmed', channelId: 'vc1', customerId: 'cu1', dealType: 'flat' },
      10,
    )

    const sql = sqlAt()
    expect(sql).toContain('s.status = $2')
    expect(sql).toContain('s.channel_id = $3')
    expect(sql).toContain('s.customer_id = $4')
    expect(sql).toContain('s.deal_type = $5')
    expect(sql).toContain('LIMIT $6')
    expect(paramsAt()).toEqual([TENANT, 'confirmed', 'vc1', 'cu1', 'flat', 10])
  })

  it('a customer-linked row still surfaces via mapping (regression)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [rawSponsorshipRow({ amount: '0.00', confidence: '1.000', status: 'dismissed' })],
    })

    const { listSponsorship } = await import('../../../src/db/sponsorship')
    const rows = await listSponsorship(USER_CTX, { status: 'dismissed' })

    expect(rows[0]!.amount).toBe(0)
    expect(rows[0]!.confidence).toBe(1)
    expect(rows[0]!.status).toBe('dismissed')
    expect(sqlAt()).toContain('s.status = $3')
    expect(paramsAt()).toEqual([TENANT, USER, 'dismissed', 50])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  getSponsorship
// ═══════════════════════════════════════════════════════════════════════════

describe('sponsorship – getSponsorship', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('returns the mapped row when found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [rawSponsorshipRow()] })

    const { getSponsorship } = await import('../../../src/db/sponsorship')
    const row = await getSponsorship(ADMIN_CTX, 'sp1')

    expect(row).not.toBeNull()
    expect(row!.id).toBe('sp1')
    expect(row!.amount).toBe(1500)
    expect(row!.confidence).toBe(0.85)
    expect(sqlAt()).toContain('s.id = $2')
    expect(sqlAt()).toContain('s.tenant_id = $1')
    expect(sqlAt()).toContain('LIMIT 1')
    expect(paramsAt()).toEqual([TENANT, 'sp1'])
  })

  it('returns null when missing or not visible', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { getSponsorship } = await import('../../../src/db/sponsorship')
    expect(await getSponsorship(USER_CTX, 'nope')).toBeNull()
    // non-admin: id lands after the two visibility params → $3.
    expect(sqlAt()).toContain('s.id = $3')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  setSponsorshipStatus
// ═══════════════════════════════════════════════════════════════════════════

describe('sponsorship – setSponsorshipStatus', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('updates and returns the row when visible', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'sp1', status: 'confirmed' }] })

    const { setSponsorshipStatus } = await import('../../../src/db/sponsorship')
    const result = await setSponsorshipStatus(ADMIN_CTX, 'sp1', 'confirmed')

    expect(result).toEqual({ id: 'sp1', status: 'confirmed' })
    const sql = sqlAt()
    expect(sql).toContain('UPDATE sponsorship_income AS s')
    expect(sql).toContain('SET status = $2')
    expect(sql).toContain('updated_at = now()')
    expect(sql).toContain('s.id = $3')
    expect(sql).toContain('RETURNING s.id, s.status')
    expect(paramsAt()).toEqual([TENANT, 'confirmed', 'sp1'])
  })

  it('returns null when the row is not visible to context', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { setSponsorshipStatus } = await import('../../../src/db/sponsorship')
    const result = await setSponsorshipStatus(USER_CTX, 'sp1', 'dismissed')

    expect(result).toBeNull()
    // non-admin: status $3, id $4, visibility $1/$2.
    expect(sqlAt()).toContain('SET status = $3')
    expect(sqlAt()).toContain('s.id = $4')
    expect(sqlAt()).toContain('s.owner_id = $2')
    expect(paramsAt()).toEqual([TENANT, USER, 'dismissed', 'sp1'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  sumSponsorship
// ═══════════════════════════════════════════════════════════════════════════

describe('sponsorship – sumSponsorship', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('defaults to confirmed and groups by brand', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ brand_name: 'ACME', deal_count: 3, total: '4500.00', currency: 'USD' }],
    })

    const { sumSponsorship } = await import('../../../src/db/sponsorship')
    const rows = await sumSponsorship(ADMIN_CTX)

    expect(rows[0]).toEqual({ brand_name: 'ACME', deal_count: 3, total: '4500.00', currency: 'USD' })
    const sql = sqlAt()
    expect(sql).toContain('GROUP BY s.brand_name')
    expect(sql).toContain('count(*)::int AS deal_count')
    expect(sql).toContain('sum(s.amount)::text AS total')
    // default status filter is 'confirmed'
    expect(paramsAt()).toEqual([TENANT, 'confirmed'])
    expect(sql).toContain('s.status = $2')
  })

  it('honours an explicit status and every filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { sumSponsorship } = await import('../../../src/db/sponsorship')
    await sumSponsorship(ADMIN_CTX, {
      status: 'dismissed',
      customerId: 'cu1',
      channelId: 'vc1',
      from: '2026-01-01',
      to: '2026-12-31',
    })

    const sql = sqlAt()
    expect(sql).toContain('s.status = $2')
    expect(sql).toContain('s.customer_id = $3')
    expect(sql).toContain('s.channel_id = $4')
    expect(sql).toContain('s.deal_date >= $5::date')
    expect(sql).toContain('s.deal_date <= $6::date')
    expect(paramsAt()).toEqual([TENANT, 'dismissed', 'cu1', 'vc1', '2026-01-01', '2026-12-31'])
  })

  it('scopes aggregates by visibility for non-admins', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { sumSponsorship } = await import('../../../src/db/sponsorship')
    await sumSponsorship(USER_CTX, { customerId: 'cu1' })

    expect(sqlAt()).toContain('s.owner_id = $2')
    expect(paramsAt()).toEqual([TENANT, USER, 'confirmed', 'cu1'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  resolveChannelByBrand
// ═══════════════════════════════════════════════════════════════════════════

describe('sponsorship – resolveChannelByBrand', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('resolves a single channel by brand name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'vc1' }] })

    const { resolveChannelByBrand } = await import('../../../src/db/sponsorship')
    const id = await resolveChannelByBrand(TENANT, { brandName: 'ACME' })

    expect(id).toBe('vc1')
    const sql = sqlAt()
    expect(sql).toContain('FROM video_channels v')
    expect(sql).toContain('LEFT JOIN customers c ON c.id = v.customer_id')
    expect(sql).toContain('lower(btrim(v.channel_name)) = lower(btrim($2))')
    expect(sql).toContain('lower(btrim(c.company)) = lower(btrim($2))')
    expect(sql).toContain('LIMIT 2')
    expect(paramsAt()).toEqual([TENANT, 'ACME'])
  })

  it('applies a platform filter alongside the name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'vc2' }] })

    const { resolveChannelByBrand } = await import('../../../src/db/sponsorship')
    const id = await resolveChannelByBrand(TENANT, { channelHint: 'TechTube', platform: 'youtube' })

    expect(id).toBe('vc2')
    expect(sqlAt()).toContain('v.platform = $2')
    expect(sqlAt()).toContain('lower(btrim(v.channel_name)) = lower(btrim($3))')
    expect(paramsAt()).toEqual([TENANT, 'youtube', 'TechTube'])
  })

  it('falls back to email when no name is given', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'vc3' }] })

    const { resolveChannelByBrand } = await import('../../../src/db/sponsorship')
    const id = await resolveChannelByBrand(TENANT, { email: 'ads@brand.test' })

    expect(id).toBe('vc3')
    expect(sqlAt()).toContain('lower(c.email) = lower($2)')
    expect(paramsAt()).toEqual([TENANT, 'ads@brand.test'])
  })

  it('returns null when there is no match', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const { resolveChannelByBrand } = await import('../../../src/db/sponsorship')
    expect(await resolveChannelByBrand(TENANT, { brandName: 'Ghost' })).toBeNull()
  })

  it('returns null when more than one channel matches (ambiguous)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'vc1' }, { id: 'vc2' }] })

    const { resolveChannelByBrand } = await import('../../../src/db/sponsorship')
    expect(await resolveChannelByBrand(TENANT, { brandName: 'ACME' })).toBeNull()
  })

  it('skips the query entirely when neither name nor email is provided', async () => {
    const { resolveChannelByBrand } = await import('../../../src/db/sponsorship')
    const id = await resolveChannelByBrand(TENANT, { platform: 'twitch' })

    expect(id).toBeNull()
    expect(mockQuery).not.toHaveBeenCalled()
  })
})
