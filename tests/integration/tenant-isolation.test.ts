import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { ToolObserve } from '@mastra/core/tools'
import { Pool } from 'pg'
import { listCustomersTool } from '../../src/mastra/tools/customers'
import { closeDbClient } from '../../src/db/client'
import type { TenantRequestContext } from '../../src/mastra/tenant-context'
import { migrate } from '../../scripts/db-migrate'

/**
 * Integration tests need a real PostgreSQL. Without one they skip rather than
 * fail, so `npm run test` stays green on a laptop with no database. §14.2.
 */
const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''

function makeObserve(): ToolObserve {
  return {
    // Method shorthand keeps `span` generic, which the framework interface needs;
    // a stub pinned to Promise<unknown> does not satisfy ToolObserve.
    span(_name, fn) {
      return Promise.resolve(fn())
    },
    log: () => {},
  }
}

function makeRequestContext(values: TenantRequestContext) {
  const rc = new RequestContext<TenantRequestContext>()
  rc.set('tenantId', values.tenantId)
  rc.set('userId', values.userId)
  rc.set('userRole', values.userRole)
  return rc
}

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const USER_A = '22222222-2222-2222-2222-222222222222'
const USER_B = '44444444-4444-4444-4444-444444444444'
const CUSTOMER_A = '11111111-1111-1111-1111-111111111111'
const CUSTOMER_B = '33333333-3333-3333-3333-333333333333'

let pool: Pool | null = null

afterAll(async () => {
  if (pool) await pool.end()
})

describe.skipIf(url === '')('Tenant Isolation', () => {
  beforeAll(async () => {
    // Ensure DATABASE_URL points at the integration database so getDbClient()
    // connects to the same schema the seed data lives in.
    process.env.DATABASE_URL = url

    // Run migrations to guarantee the customers table exists.
    const migratePool = new Pool({ connectionString: url, max: 2 })
    try {
      await migrate(migratePool)
    } finally {
      await migratePool.end()
    }

    pool = new Pool({ connectionString: url, max: 2 })
    // Seed test data for two tenants
    await pool.query(`
      INSERT INTO customers (id, tenant_id, name, owner_id, team_member_ids) VALUES
        ($1, $2, 'Tenant A Customer', $3, ARRAY[]::uuid[]),
        ($4, $5, 'Tenant B Customer', $6, ARRAY[]::uuid[])
      ON CONFLICT (id) DO NOTHING
    `, [CUSTOMER_A, TENANT_A, USER_A, CUSTOMER_B, TENANT_B, USER_B])
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`
        DELETE FROM customers WHERE id IN ($1, $2)
      `, [CUSTOMER_A, CUSTOMER_B])
    }
    await closeDbClient()
  })

  it('user from Tenant A cannot see Tenant B customers', async () => {
    const contextA: TenantRequestContext = {
      tenantId: TENANT_A,
      userId: USER_A,
      userRole: 'user',
    }

    const result = await listCustomersTool.execute?.(
      {},
      { requestContext: makeRequestContext(contextA), observe: makeObserve() },
    )

    expect(result).toBeDefined()
    expect(Array.isArray(result)).toBe(true)
    const customers = result as Array<{ tenant_id: string }>
    customers.forEach((c) => {
      expect(c.tenant_id).toBe(TENANT_A)
      expect(c.tenant_id).not.toBe(TENANT_B)
    })
  })

  it('user from Tenant B cannot see Tenant A customers', async () => {
    const contextB: TenantRequestContext = {
      tenantId: TENANT_B,
      userId: USER_B,
      userRole: 'user',
    }

    const result = await listCustomersTool.execute?.(
      {},
      { requestContext: makeRequestContext(contextB), observe: makeObserve() },
    )

    expect(result).toBeDefined()
    expect(Array.isArray(result)).toBe(true)
    const customers = result as Array<{ tenant_id: string }>
    customers.forEach((c) => {
      expect(c.tenant_id).toBe(TENANT_B)
      expect(c.tenant_id).not.toBe(TENANT_A)
    })
  })
})
