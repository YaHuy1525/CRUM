import { describe, it, expect, vi } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { ToolObserve } from '@mastra/core/tools'
import type { TenantRequestContext } from '../../../src/mastra/tenant-context'
import { searchTool } from '../../../src/mastra/tools/search'

vi.mock('../../../src/db/queries', () => ({
  querySearch: vi.fn().mockResolvedValue([
    { type: 'customer', id: 'c1', label: 'Acme', tenant_id: '550e8400-e29b-41d4-a716-446655440000' },
  ]),
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

describe('searchTool', () => {
  it('has correct id and description', () => {
    expect(searchTool.id).toBe('crm.search')
    expect(searchTool.description).toBeTruthy()
  })

  it('has requestContextSchema defined', () => {
    expect(searchTool.requestContextSchema).toBeDefined()
  })

  it('executes and returns an array', async () => {
    const observe = makeObserve()
    const result = await searchTool.execute?.(
      { query: 'Acme' },
      { requestContext: makeRequestContext(mockContext), observe },
    )
    expect(Array.isArray(result)).toBe(true)
  })
})
