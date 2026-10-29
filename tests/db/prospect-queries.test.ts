import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
const mockPool = { query: mockQuery, end: vi.fn() }

vi.mock('pg', () => ({ Pool: vi.fn(() => mockPool) }))
vi.mock('../../src/config/env', () => ({
  parseEnv: () => ({ DATABASE_URL: 'postgres://test:test@localhost:5432/testdb', NODE_ENV: 'test' }),
}))

const rc = { tenantId: '11111111-1111-1111-1111-111111111111', userId: '22222222-2222-2222-2222-222222222222', userRole: 'admin' as const }

/** The first query a call issued, typed so the strict tsconfig can read it. */
function firstCall(): { sql: string; params: unknown[] } {
  const call = mockQuery.mock.calls[0] as unknown[] | undefined
  if (!call) throw new Error('no query was issued')
  return { sql: call[0] as string, params: call[1] as unknown[] }
}

describe('queryProspects', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('scopes the query on tenant id', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { queryProspects } = await import('../../src/db/prospect-queries')
    await queryProspects(rc, {})
    const { sql, params } = firstCall()
    expect(sql).toContain('p.tenant_id = $1')
    expect(params[0]).toBe(rc.tenantId)
  })

  it('adds a country filter when supplied', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { queryProspects } = await import('../../src/db/prospect-queries')
    await queryProspects(rc, { country: 'VN' })
    expect(firstCall().sql).toContain('p.country = $2')
  })

  it('orders by score descending by default', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { queryProspects } = await import('../../src/db/prospect-queries')
    await queryProspects(rc, {})
    expect(firstCall().sql).toContain('ORDER BY s.total DESC NULLS LAST')
  })
})

describe('queryProspect', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
  })

  it('returns null when the prospect is not visible', async () => {
    mockQuery.mockResolvedValue({ rows: [] })
    const { queryProspect } = await import('../../src/db/prospect-queries')
    const result = await queryProspect(rc, '33333333-3333-3333-3333-333333333333')
    expect(result).toBeNull()
  })
})
