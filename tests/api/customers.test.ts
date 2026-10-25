// tests/api/customers.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'

/**
 * `GET /api/crm/customers/:id` exists so the console's object panel can show a
 * real record, which makes the one thing it must never get wrong the thing under
 * test: the tenant boundary. The route holds no SQL of its own — it hands the
 * verified identity to `queryCustomer`, the same function `crm.get_customer`
 * calls — so these tests assert that the identity actually arrives, and that a
 * lookup which returns nothing is reported as a miss rather than an empty object.
 *
 * The DB module is mocked, so no DATABASE_URL and no Supabase.
 */
const queries = vi.hoisted(() => ({ queryCustomer: vi.fn() }))

vi.mock('../../src/db/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/queries')>()
  return { ...actual, ...queries }
})

import { createCustomerRouter } from '../../src/api/customers'
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
  return createCustomerRouter({ env: parseEnv({}) })
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

  it('scopes the read to the verified identity, not to a header it re-reads', async () => {
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

describe('the record itself', () => {
  it('returns the row under a `customer` key', async () => {
    queries.queryCustomer.mockResolvedValue(row({ city: 'Lisbon', tags: ['priority'] }))

    const body = await json<{ customer: Record<string, unknown> }>(
      router().request(`/api/crm/customers/${CUSTOMER}`, { headers: AUTH }),
    )

    expect(body.customer).toMatchObject({ id: CUSTOMER, name: 'Acme Robotics', city: 'Lisbon', tags: ['priority'] })
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
