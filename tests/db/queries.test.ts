import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Pool } from 'pg'

// Mock pg module
const mockQuery = vi.fn()
const mockEnd = vi.fn()
const mockPool = {
  query: mockQuery,
  end: mockEnd,
} as unknown as Pool

vi.mock('pg', () => ({
  Pool: vi.fn(() => mockPool),
}))

// Mock env to provide DATABASE_URL
vi.mock('@/config/env.js', () => ({
  parseEnv: () => ({
    DATABASE_URL: 'postgres://test:test@localhost:5432/testdb',
    NODE_ENV: 'test',
  }),
}))

describe('getDbClient', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
    mockEnd.mockReset()
  })

  it('returns a Pool instance', async () => {
    const { getDbClient } = await import('@/db/client.js')
    const client = getDbClient()
    expect(client).toBeDefined()
    expect(client).toBe(mockPool)
  })

  it('returns the same singleton on subsequent calls', async () => {
    const { getDbClient } = await import('@/db/client.js')
    const a = getDbClient()
    const b = getDbClient()
    expect(a).toBe(b)
  })
})

describe('queryCustomers', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
    mockEnd.mockReset()
  })

  it('queries customers with tenant scope for admin', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c1', name: 'Alice' }] })
    const { queryCustomers } = await import('@/db/queries.js')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    const result = await queryCustomers(context, { city: 'Berlin' })
    expect(result).toHaveLength(1)
    expect(mockQuery).toHaveBeenCalledOnce()
    const sql = mockQuery.mock.calls[0]![0] as string
    expect(sql).toContain('tenant_id = $1')
    expect(sql).toContain('city = $2')
    // admin should NOT have owner_id predicate
    expect(sql).not.toContain('owner_id')
  })

  it('queries customers with owner predicate for user role', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { queryCustomers } = await import('@/db/queries.js')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'user' as const }
    await queryCustomers(context, { name: 'Bob', tags: ['vip'] })
    const sql = mockQuery.mock.calls[0]![0] as string
    expect(sql).toContain('owner_id = $2')
    expect(sql).toContain('ANY(team_member_ids)')
    expect(sql).toContain('ILIKE')
    expect(sql).toContain('@>')
  })
})

describe('queryCustomer', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
    mockEnd.mockReset()
  })

  it('returns null when customer is not visible', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { queryCustomer } = await import('@/db/queries.js')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'user' as const }
    const result = await queryCustomer(context, 'nonexistent-id')
    expect(result).toBeNull()
  })

  it('returns the customer row when visible', async () => {
    const row = { id: 'c1', name: 'Alice', tenant_id: 't1' }
    mockQuery.mockResolvedValueOnce({ rows: [row] })
    const { queryCustomer } = await import('@/db/queries.js')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    const result = await queryCustomer(context, 'c1')
    expect(result).toEqual(row)
  })
})

describe('child table queries', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
    mockEnd.mockReset()
  })

  it('queryContacts returns array', async () => {
    // First call: queryCustomer check
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c1' }] })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'ct1', name: 'Contact' }] })
    const { queryContacts } = await import('@/db/queries.js')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    const result = await queryContacts(context, 'c1')
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
  })

  it('queryFollowups returns array', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c1' }] })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'f1' }] })
    const { queryFollowups } = await import('@/db/queries.js')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    const result = await queryFollowups(context, 'c1')
    expect(Array.isArray(result)).toBe(true)
  })

  it('queryTasks returns array', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c1' }] })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'tk1' }] })
    const { queryTasks } = await import('@/db/queries.js')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    const result = await queryTasks(context, 'c1')
    expect(Array.isArray(result)).toBe(true)
  })

  it('querySchedules returns array', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c1' }] })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 's1' }] })
    const { querySchedules } = await import('@/db/queries.js')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    const result = await querySchedules(context, 'c1')
    expect(Array.isArray(result)).toBe(true)
  })

  it('child queries return empty array when customer not visible', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { queryContacts } = await import('@/db/queries.js')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'user' as const }
    const result = await queryContacts(context, 'hidden-id')
    expect(result).toEqual([])
    expect(mockQuery).toHaveBeenCalledOnce()
  })
})
