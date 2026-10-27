import { describe, it, expect, vi } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { ToolObserve } from '@mastra/core/tools'
import type { TenantRequestContext } from '../../../src/mastra/tenant-context'
import { listCustomersTool, getCustomerTool } from '../../../src/mastra/tools/customers'

vi.mock('../../../src/db/queries', () => ({
  queryCustomers: vi.fn().mockResolvedValue([
    { id: 'c1', tenant_id: '550e8400-e29b-41d4-a716-446655440000', name: 'Acme', owner_id: 'u1', team_member_ids: [], created_at: '2024-01-01', updated_at: '2024-01-01' },
  ]),
  queryCustomer: vi.fn().mockResolvedValue({
    id: 'c1', tenant_id: '550e8400-e29b-41d4-a716-446655440000', name: 'Acme', owner_id: 'u1', team_member_ids: [], created_at: '2024-01-01', updated_at: '2024-01-01',
  }),
}))

const mockContext: TenantRequestContext = {
  tenantId: '550e8400-e29b-41d4-a716-446655440000',
  userId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  userRole: 'admin',
}

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

describe('listCustomersTool', () => {
  it('has correct id and description', () => {
    expect(listCustomersTool.id).toBe('crm.list_customers')
    expect(listCustomersTool.description).toBeTruthy()
  })

  it('has requestContextSchema defined', () => {
    expect(listCustomersTool.requestContextSchema).toBeDefined()
  })

  it('executes and returns an array', async () => {
    const observe = makeObserve()
    const result = await listCustomersTool.execute?.(
      {},
      { requestContext: makeRequestContext(mockContext), observe },
    )
    expect(Array.isArray(result)).toBe(true)
  })
})

describe('getCustomerTool', () => {
  it('has correct id and description', () => {
    expect(getCustomerTool.id).toBe('crm.get_customer')
    expect(getCustomerTool.description).toBeTruthy()
  })

  it('has requestContextSchema defined', () => {
    expect(getCustomerTool.requestContextSchema).toBeDefined()
  })

  it('executes and returns an object or null', async () => {
    const observe = makeObserve()
    const result = await getCustomerTool.execute?.(
      { id: '550e8400-e29b-41d4-a716-446655440000' },
      { requestContext: makeRequestContext(mockContext), observe },
    )
    expect(result === null || typeof result === 'object').toBe(true)
  })
})
