import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { Pool } from 'pg'
import { getCustomerTool } from '../../src/mastra/tools/customers'
import { getDbClient, closeDbClient } from '../../src/db/client'
import type { TenantRequestContext } from '../../src/mastra/tenant-context'
import { migrate } from '../../scripts/db-migrate'

/**
 * Integration tests need a real PostgreSQL. Without one they skip rather than
 * fail, so `npm run test` stays green on a laptop with no database. §14.2.
 */
const url = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''

function makeObserve() {
  return {
    span: async (_name: string, fn: () => Promise<unknown>) => fn(),
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

const CUSTOMER_ID = '55555555-5555-5555-5555-555555555555'
const OWNER_ID = '66666666-6666-6666-6666-666666666666'
const OTHER_USER_ID = '77777777-7777-7777-7777-777777777777'
const TENANT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

let pool: Pool | null = null

afterAll(async () => {
  if (pool) await pool.end()
})

describe.skipIf(url === '')('User Isolation', () => {
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
    await pool.query(`
      INSERT INTO customers (id, tenant_id, name, owner_id, team_member_ids) VALUES
        ($1, $2, 'Owner Customer', $3, ARRAY[]::uuid[])
      ON CONFLICT (id) DO NOTHING
    `, [CUSTOMER_ID, TENANT_ID, OWNER_ID])
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM customers WHERE id = $1`, [CUSTOMER_ID])
    }
    await closeDbClient()
  })

  it('owner can see their own customer', async () => {
    const context: TenantRequestContext = {
      tenantId: TENANT_ID,
      userId: OWNER_ID,
      userRole: 'user',
    }

    const result = await getCustomerTool.execute?.(
      { id: CUSTOMER_ID },
      { requestContext: makeRequestContext(context), observe: makeObserve() } as any,
    )

    expect(result).toBeDefined()
    expect((result as { id: string })?.id).toBe(CUSTOMER_ID)
  })

  it('non-owner cannot see the customer', async () => {
    const context: TenantRequestContext = {
      tenantId: TENANT_ID,
      userId: OTHER_USER_ID,
      userRole: 'user',
    }

    const result = await getCustomerTool.execute?.(
      { id: CUSTOMER_ID },
      { requestContext: makeRequestContext(context), observe: makeObserve() } as any,
    )

    expect(result).toBeNull()
  })

  it('admin can see any customer in their tenant', async () => {
    const context: TenantRequestContext = {
      tenantId: TENANT_ID,
      userId: OTHER_USER_ID,
      userRole: 'admin',
    }

    const result = await getCustomerTool.execute?.(
      { id: CUSTOMER_ID },
      { requestContext: makeRequestContext(context), observe: makeObserve() } as any,
    )

    expect(result).toBeDefined()
    expect((result as { id: string })?.id).toBe(CUSTOMER_ID)
  })
})
