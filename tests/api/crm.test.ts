// tests/api/crm.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

/**
 * `/api/crm` is the console's only read path into CRM rows, and it is deliberately
 * a second face of the agent's own read tools. The two things that must never
 * drift are therefore what is under test here:
 *
 * 1. **The identity arrives.** Every route hands the verified tenant/user/role to
 *    the same query function the tool calls, because that context is what builds
 *    the visibility predicate. A route that passed something else would leave role
 *    scoping silently gone while the HTTP response still looked perfect.
 * 2. **The page request is validated, not trusted.** A limit of 10000 or a typo'd
 *    customer id is a 400 before any SQL runs, not a silent unfiltered list.
 *
 * The DB module is mocked, so no DATABASE_URL and no Supabase.
 */
const queries = vi.hoisted(() => ({
  queryCustomer: vi.fn(),
  queryCustomersPage: vi.fn(),
  queryContactsPage: vi.fn(),
  queryFollowupsPage: vi.fn(),
  queryTasksPage: vi.fn(),
  querySchedulesPage: vi.fn(),
}))

vi.mock('../../src/db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/queries')>()
  return { ...actual, ...queries }
})

import { createCrmRouter } from '../../src/api/crm'
import { parseEnv } from '../../src/config/env'

const TENANT = '550e8400-e29b-41d4-a716-446655440000'
const USER = '660e8400-e29b-41d4-a716-446655440009'
const CUSTOMER = '990e8400-e29b-41d4-a716-446655440005'

const AUTH = {
  'x-tenant-id': TENANT,
  'x-user-id': USER,
  'x-user-role': 'user',
}

function router(): Hono {
  return createCrmRouter({ env: parseEnv({}) })
}

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await res).json() as Promise<T>
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER,
    tenant_id: TENANT,
    name: 'Acme Robotics',
    owner_id: USER,
    team_member_ids: [],
    created_at: '2026-10-20T09:00:00.000Z',
    updated_at: '2026-10-20T09:00:00.000Z',
    ...over,
  }
}

function page(items: unknown[], total = items.length) {
  return { items, total }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('identity gate', () => {
  it('refuses an incomplete identity before touching the database', async () => {
    const res = await router().request(`/api/crm/customers/${CUSTOMER}`, {
      headers: { 'x-tenant-id': TENANT },
    })

    expect(res.status).toBe(401)
    // 'invalid-claim' and not 'missing-claim': the schema only calls a claim set
    // wholly absent when nothing at all arrived, which is what keeps a partial
    // header set from being treated as a defaults-allowed request.
    expect((await json<{ error?: string; reason?: string }>(res)).reason).toBe('invalid-claim')
    expect(queries.queryCustomer).not.toHaveBeenCalled()
  })

  it('gates the lists as well, before any query runs', async () => {
    const res = await router().request('/api/crm/tasks', { headers: {} })

    expect(res.status).toBe(401)
    expect(queries.queryTasksPage).not.toHaveBeenCalled()
  })

  it('scopes the detail read to the verified identity, not to a header it re-reads', async () => {
    queries.queryCustomer.mockResolvedValue(row())

    const res = await router().request(`/api/crm/customers/${CUSTOMER}`, { headers: AUTH })
    expect(res.status).toBe(200)

    // The first argument is the context `queryCustomer` builds its visibility
    // predicate from — if the route passed anything else, role scoping would be
    // silently gone while every test here still passed.
    expect(queries.queryCustomer).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: USER, userRole: 'user' },
      CUSTOMER,
    )
  })

  it('carries an admin claim through, which is what widens the visibility rule', async () => {
    queries.queryCustomer.mockResolvedValue(row())

    await router().request(`/api/crm/customers/${CUSTOMER}`, {
      headers: { ...AUTH, 'x-user-role': 'admin' },
    })

    expect(queries.queryCustomer.mock.calls[0]![0]).toMatchObject({ userRole: 'admin' })
  })
})

describe('the customer record', () => {
  it('returns the row under a `customer` key', async () => {
    queries.queryCustomer.mockResolvedValue(row({ city: 'Lisbon', tags: ['priority'] }))

    const body = await json<{ customer: Record<string, unknown> }>(
      router().request(`/api/crm/customers/${CUSTOMER}`, { headers: AUTH }),
    )

    expect(body.customer).toMatchObject({
      id: CUSTOMER,
      name: 'Acme Robotics',
      city: 'Lisbon',
      tags: ['priority'],
    })
  })

  it('answers 404 for a customer the caller cannot see, without saying which', async () => {
    // `queryCustomer` returns null for both "no such row" and "not yours", and
    // the route must not try to tell them apart.
    queries.queryCustomer.mockResolvedValue(null)

    const res = await router().request(`/api/crm/customers/${CUSTOMER}`, { headers: AUTH })
    expect(res.status).toBe(404)
    expect(await json<Record<string, unknown>>(res)).toEqual({ error: 'not_found' })
  })

  it('rejects a non-uuid id with 400 rather than a driver cast error', async () => {
    const res = await router().request('/api/crm/customers/anything-goes-here', { headers: AUTH })

    expect(res.status).toBe(400)
    expect((await json<{ error?: string }>(res)).error).toContain('uuid')
    expect(queries.queryCustomer).not.toHaveBeenCalled()
  })
})

describe('the lists', () => {
  it('defaults to the first page of 25 and reports the page it served', async () => {
    queries.queryCustomersPage.mockResolvedValue(page([row()], 40))

    const body = await json<{
      items: unknown[]
      total: number
      limit: number
      offset: number
      hasMore: boolean
    }>(router().request('/api/crm/customers', { headers: AUTH }))

    expect(queries.queryCustomersPage).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: USER, userRole: 'user' },
      { name: undefined, city: undefined, tags: undefined },
      { limit: 25, offset: 0 },
    )
    expect(body).toMatchObject({ total: 40, limit: 25, offset: 0, hasMore: true })
    expect(body.items).toHaveLength(1)
  })

  it('splits the tags filter, because a comma is what a URL can carry', async () => {
    queries.queryCustomersPage.mockResolvedValue(page([], 0))

    await router().request('/api/crm/customers?tags=priority,%20enterprise&name=Nord', {
      headers: AUTH,
    })

    expect(queries.queryCustomersPage.mock.calls[0]![1]).toEqual({
      name: 'Nord',
      city: undefined,
      tags: ['priority', 'enterprise'],
    })
  })

  it('reports hasMore false on the last page', async () => {
    queries.queryCustomersPage.mockResolvedValue(page([row()], 26))

    const body = await json<{ hasMore: boolean }>(
      router().request('/api/crm/customers?limit=25&offset=25', { headers: AUTH }),
    )

    expect(body.hasMore).toBe(false)
  })

  it('refuses a page size it will not serve, before the database sees it', async () => {
    for (const query of ['limit=0', 'limit=10000', 'offset=-1', 'limit=abc']) {
      const res = await router().request(`/api/crm/customers?${query}`, { headers: AUTH })
      expect(res.status, query).toBe(400)
      expect((await json<{ error?: string }>(res)).error).toBe('invalid_query')
    }
    expect(queries.queryCustomersPage).not.toHaveBeenCalled()
  })

  it('refuses a malformed customer id instead of answering the unfiltered list', async () => {
    const res = await router().request('/api/crm/contacts?customerId=nordwind', { headers: AUTH })

    expect(res.status).toBe(400)
    expect((await json<{ detail?: string }>(res)).detail).toContain('customerId')
    expect(queries.queryContactsPage).not.toHaveBeenCalled()
  })

  it('forwards the customer filter and name to the contacts read', async () => {
    queries.queryContactsPage.mockResolvedValue(page([{ id: 'ct1', name: 'Maria' }]))

    await router().request(`/api/crm/contacts?customerId=${CUSTOMER}&name=Mar`, { headers: AUTH })

    expect(queries.queryContactsPage).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: USER, userRole: 'user' },
      { customerId: CUSTOMER, name: 'Mar' },
      { limit: 25, offset: 0 },
    )
  })

  it('routes each object type to its own read, so one list cannot answer for another', async () => {
    queries.queryFollowupsPage.mockResolvedValue(page([]))
    queries.queryTasksPage.mockResolvedValue(page([]))
    queries.querySchedulesPage.mockResolvedValue(page([]))

    const app = router()
    await app.request('/api/crm/followups', { headers: AUTH })
    await app.request('/api/crm/tasks', { headers: AUTH })
    await app.request('/api/crm/schedules', { headers: AUTH })

    expect(queries.queryFollowupsPage).toHaveBeenCalledOnce()
    expect(queries.queryTasksPage).toHaveBeenCalledOnce()
    expect(queries.querySchedulesPage).toHaveBeenCalledOnce()
  })

  it('accepts a bare calendar date for schedules and refuses a timestamp', async () => {
    queries.querySchedulesPage.mockResolvedValue(page([]))
    const app = router()

    await app.request('/api/crm/schedules?date=2026-10-26', { headers: AUTH })
    expect(queries.querySchedulesPage.mock.calls[0]![1]).toEqual({
      customerId: undefined,
      date: '2026-10-26',
    })

    const res = await app.request('/api/crm/schedules?date=2026-10-26T09:00:00Z', {
      headers: AUTH,
    })
    expect(res.status).toBe(400)
    expect(queries.querySchedulesPage).toHaveBeenCalledOnce()
  })

  it('passes a validated inclusive week range through to the schedules read', async () => {
    queries.querySchedulesPage.mockResolvedValue(page([]))
    const app = router()

    await app.request('/api/crm/schedules?from=2026-10-26&to=2026-11-01&limit=100', {
      headers: AUTH,
    })
    expect(queries.querySchedulesPage.mock.calls[0]![1]).toEqual({
      customerId: undefined,
      date: undefined,
      from: '2026-10-26',
      to: '2026-11-01',
    })

    // The same date discipline as `date`: a timestamp truncates to a silently
    // different day west of UTC, and an inverted range is a caller bug rather
    // than an empty page.
    const ts = await app.request('/api/crm/schedules?from=2026-10-26T00:00:00Z', {
      headers: AUTH,
    })
    expect(ts.status).toBe(400)
    const inverted = await app.request('/api/crm/schedules?from=2026-11-02&to=2026-10-26', {
      headers: AUTH,
    })
    expect(inverted.status).toBe(400)
    expect(queries.querySchedulesPage).toHaveBeenCalledOnce()
  })
})
