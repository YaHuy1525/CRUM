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
vi.mock('../../src/config/env', () => ({
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
    const { getDbClient } = await import('../../src/db/client')
    const client = getDbClient()
    expect(client).toBeDefined()
    expect(client).toBe(mockPool)
  })

  it('returns the same singleton on subsequent calls', async () => {
    const { getDbClient } = await import('../../src/db/client')
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
    const { queryCustomers } = await import('../../src/db/queries')
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
    const { queryCustomers } = await import('../../src/db/queries')
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
    const { queryCustomer } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'user' as const }
    const result = await queryCustomer(context, 'nonexistent-id')
    expect(result).toBeNull()
  })

  it('returns the customer row when visible', async () => {
    const row = { id: 'c1', name: 'Alice', tenant_id: 't1' }
    mockQuery.mockResolvedValueOnce({ rows: [row] })
    const { queryCustomer } = await import('../../src/db/queries')
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
    const { queryContacts } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    const result = await queryContacts(context, 'c1')
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
  })

  it('queryFollowups returns array', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c1' }] })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'f1' }] })
    const { queryFollowups } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    const result = await queryFollowups(context, 'c1')
    expect(Array.isArray(result)).toBe(true)
  })

  it('queryTasks returns array', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c1' }] })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'tk1' }] })
    const { queryTasks } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    const result = await queryTasks(context, 'c1')
    expect(Array.isArray(result)).toBe(true)
  })

  it('querySchedules returns array', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c1' }] })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 's1' }] })
    const { querySchedules } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    const result = await querySchedules(context, 'c1')
    expect(Array.isArray(result)).toBe(true)
  })

  it('child queries return empty array when customer not visible', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { queryContacts } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'user' as const }
    const result = await queryContacts(context, 'hidden-id')
    expect(result).toEqual([])
    expect(mockQuery).toHaveBeenCalledOnce()
  })
})

describe('tenant isolation on child tables', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
    mockEnd.mockReset()
  })

  it('queryContacts SQL contains tenant_id filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c1' }] })
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { queryContacts } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    await queryContacts(context, 'c1')
    // Second call is the child query
    const sql = mockQuery.mock.calls[1]![0] as string
    expect(sql).toContain('tenant_id = $2')
    expect(sql).toContain('customer_id = $1')
  })

  it('queryFollowups SQL contains tenant_id filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c1' }] })
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { queryFollowups } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    await queryFollowups(context, 'c1')
    const sql = mockQuery.mock.calls[1]![0] as string
    expect(sql).toContain('tenant_id = $2')
    expect(sql).toContain('customer_id = $1')
  })

  it('queryTasks SQL contains tenant_id filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c1' }] })
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { queryTasks } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    await queryTasks(context, 'c1')
    const sql = mockQuery.mock.calls[1]![0] as string
    expect(sql).toContain('tenant_id = $2')
    expect(sql).toContain('customer_id = $1')
  })

  it('querySchedules SQL contains tenant_id filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c1' }] })
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { querySchedules } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    await querySchedules(context, 'c1')
    const sql = mockQuery.mock.calls[1]![0] as string
    expect(sql).toContain('tenant_id = $2')
    expect(sql).toContain('customer_id = $1')
  })

  it('child queries enforce tenant isolation for user role', async () => {
    // Customer visible to user
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c1', owner_id: 'u1' }] })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'ct1' }] })
    const { queryContacts } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'user' as const }
    const result = await queryContacts(context, 'c1')
    expect(result).toHaveLength(1)
    // Verify the child query was called with tenant_id param
    const childParams = mockQuery.mock.calls[1]![1] as unknown[]
    expect(childParams).toContain('t1')
  })

  it('child queries return empty when customer not visible for user role', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { queryFollowups } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'user' as const }
    const result = await queryFollowups(context, 'other-tenant-customer')
    expect(result).toEqual([])
    expect(mockQuery).toHaveBeenCalledOnce()
  })
})

describe('querySearch', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
    mockEnd.mockReset()
  })

  it('admin role: omits owner predicate on contacts and tasks sub-queries', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { type: 'customer', id: 'c1', label: 'Acme', tenant_id: 't1' },
        { type: 'contact', id: 'ct1', label: 'Alice', tenant_id: 't1' },
        { type: 'task', id: 'tk1', label: 'Follow up', tenant_id: 't1' },
      ],
    })
    const { querySearch } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    const result = await querySearch(context, 'test')

    expect(result).toHaveLength(3)
    expect(mockQuery).toHaveBeenCalledOnce()

    const sql = mockQuery.mock.calls[0]![0] as string
    const params = mockQuery.mock.calls[0]![1] as unknown[]

    // Admin should NOT have owner_id predicate anywhere in the UNION query
    expect(sql).not.toContain('owner_id')

    // Params should be [tenantId, pattern, limit] — no userId
    expect(params).toEqual(['t1', '%test%', 20])

    // Verify tenant_id filter is present
    expect(sql).toContain('tenant_id = $1')
    // Verify ILIKE pattern uses $2
    expect(sql).toContain('ILIKE $2')
    // Verify limit uses $3
    expect(sql).toContain('LIMIT $3')
  })

  it('user role: includes owner predicate with correct param index on all sub-queries', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { querySearch } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'user' as const }
    await querySearch(context, 'test')

    const sql = mockQuery.mock.calls[0]![0] as string
    const params = mockQuery.mock.calls[0]![1] as unknown[]

    // User role should have owner_id predicate with $2
    expect(sql).toContain('owner_id = $2')
    expect(sql).toContain('ANY(team_member_ids)')

    // Params should be [tenantId, userId, pattern, limit]
    expect(params).toEqual(['t1', 'u1', '%test%', 20])

    // Verify ILIKE pattern uses $3 (not $2)
    expect(sql).toContain('ILIKE $3')
    // Verify limit uses $4
    expect(sql).toContain('LIMIT $4')
  })

  it('admin role: returns contacts and tasks for matching query', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { type: 'contact', id: 'ct1', label: 'Bob', tenant_id: 't1' },
        { type: 'task', id: 'tk1', label: 'Call Bob', tenant_id: 't1' },
      ],
    })
    const { querySearch } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'admin-u', userRole: 'admin' as const }
    const result = await querySearch(context, 'Bob')

    // Admin should get both contact and task results (not blocked by owner predicate)
    expect(result).toHaveLength(2)
    expect(result[0]!.type).toBe('contact')
    expect(result[1]!.type).toBe('task')
  })

  it('respects custom limit parameter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const { querySearch } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }
    await querySearch(context, 'x', 5)

    const params = mockQuery.mock.calls[0]![1] as unknown[]
    expect(params[2]).toBe(5)
  })
})
