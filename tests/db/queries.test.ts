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

/**
 * The paged list reads behind `GET /api/crm/*`. Every one of them is a second
 * path to data the agent's tools already expose, so the thing worth asserting is
 * not that SQL was sent but that the SQL carries the *same* visibility predicate:
 * a tenant-wide child list that forgot the parent's owner rule would be a read
 * wider than the tool it mirrors, and every row it returned would look correct.
 *
 * Each read issues two statements (count, then page), so the mocks resolve twice.
 */
describe('paged list reads', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQuery.mockReset()
    mockEnd.mockReset()
  })

  function twoCalls(count: number, rows: unknown[] = []) {
    mockQuery.mockResolvedValueOnce({ rows: [{ count }] })
    mockQuery.mockResolvedValueOnce({ rows })
  }

  it('customers: admin counts and pages with the tenant rule only', async () => {
    twoCalls(42, [{ id: 'c1', name: 'Acme' }])
    const { queryCustomersPage } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }

    const result = await queryCustomersPage(context, { name: 'Ac' }, { limit: 25, offset: 50 })

    expect(result).toEqual({ items: [{ id: 'c1', name: 'Acme' }], total: 42 })
    const countSql = mockQuery.mock.calls[0]![0] as string
    const countParams = mockQuery.mock.calls[0]![1] as unknown[]
    const pageSql = mockQuery.mock.calls[1]![0] as string
    const pageParams = mockQuery.mock.calls[1]![1] as unknown[]

    expect(countSql).toContain('count(*)::int')
    expect(countSql).toContain('deleted_at IS NULL')
    expect(countSql).toContain('name ILIKE $2')
    expect(countSql).not.toContain('owner_id')
    expect(countParams).toEqual(['t1', '%Ac%'])

    expect(pageSql).toContain('ORDER BY created_at DESC, id DESC')
    expect(pageSql).toContain('LIMIT $3 OFFSET $4')
    expect(pageParams).toEqual(['t1', '%Ac%', 25, 50])
  })

  it('contacts: user role inherits visibility from the joined customer', async () => {
    twoCalls(1, [{ id: 'ct1', name: 'Maria' }])
    const { queryContactsPage } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'user' as const }

    await queryContactsPage(context, { customerId: 'c1', name: 'Mar' }, { limit: 10, offset: 0 })

    const sql = mockQuery.mock.calls[1]![0] as string
    const params = mockQuery.mock.calls[1]![1] as unknown[]

    // The tool's own gate: `queryContacts` returns [] unless `queryCustomer` did.
    expect(sql).toContain('JOIN customers cu ON cu.id = c.customer_id')
    expect(sql).toContain('cu.owner_id = $2 OR $2 = ANY(cu.team_member_ids)')
    expect(sql).toContain('cu.deleted_at IS NULL')
    expect(sql).toContain('c.customer_id = $3')
    expect(sql).toContain('c.name ILIKE $4')
    expect(params).toEqual(['t1', 'u1', 'c1', '%Mar%', 10, 0])
  })

  it('followups: admin sees the tenant, still through the parent join', async () => {
    twoCalls(0)
    const { queryFollowupsPage } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }

    const result = await queryFollowupsPage(context, {}, { limit: 25, offset: 0 })

    expect(result).toEqual({ items: [], total: 0 })
    const sql = mockQuery.mock.calls[1]![0] as string
    expect(sql).toContain('JOIN customers cu ON cu.id = f.customer_id')
    expect(sql).not.toContain('owner_id = $2')
    // `total: 0` must come from the count, not from the empty page.
    expect(mockQuery.mock.calls[0]![0] as string).toContain('count(*)::int')
  })

  it('tasks: an orphaned task falls back to ownership instead of vanishing', async () => {
    twoCalls(3, [{ id: 't1', title: 'Call back' }])
    const { queryTasksPage } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'user' as const }

    await queryTasksPage(context, {}, { limit: 25, offset: 0 })

    const sql = mockQuery.mock.calls[1]![0] as string
    // LEFT JOIN, not INNER: `tasks.customer_id` is nullable in 0002.
    expect(sql).toContain('LEFT JOIN customers cu ON cu.id = t.customer_id')
    expect(sql).toContain('t.customer_id IS NULL AND (t.owner_id = $2 OR t.assigned_to = $2)')
    expect(sql).toContain('cu.owner_id = $2 OR $2 = ANY(cu.team_member_ids)')
  })

  it('schedules: the date filter runs on the real start_time column', async () => {
    twoCalls(2)
    const { querySchedulesPage } = await import('../../src/db/queries')
    const context = { tenantId: 't1', userId: 'u1', userRole: 'admin' as const }

    await querySchedulesPage(context, { date: '2026-10-26' }, { limit: 5, offset: 5 })

    const sql = mockQuery.mock.calls[1]![0] as string
    const params = mockQuery.mock.calls[1]![1] as unknown[]

    // `scheduled_at` does not exist on the table; `start_time` does.
    expect(sql).toContain('date(s.start_time) = $2::date')
    expect(sql).toContain('ORDER BY s.start_time ASC, s.id ASC')
    expect(params).toEqual(['t1', '2026-10-26', 5, 5])
  })
})
