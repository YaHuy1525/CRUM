import { describe, it, expect, vi } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { TenantRequestContext } from '../../../src/mastra/tenant-context'
import { listTasksTool, myOpenItemsTool } from '../../../src/mastra/tools/tasks'

vi.mock('../../../src/db/queries', () => ({
  queryTasks: vi.fn().mockResolvedValue([
    { id: 't1', tenant_id: '550e8400-e29b-41d4-a716-446655440000', customer_id: 'c1', title: 'Task 1', owner_id: 'u1', team_member_ids: [], created_at: '2024-01-01', updated_at: '2024-01-01' },
  ]),
  queryMyTasks: vi.fn().mockResolvedValue([]),
  queryMyFollowups: vi.fn().mockResolvedValue([]),
}))

const mockContext: TenantRequestContext = {
  tenantId: '550e8400-e29b-41d4-a716-446655440000',
  userId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  userRole: 'admin',
}

function makeObserve() {
  return {
    span: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
    log: vi.fn(),
  }
}

function makeRequestContext(values: TenantRequestContext) {
  const rc = new RequestContext<TenantRequestContext>()
  rc.set('tenantId', values.tenantId)
  rc.set('userId', values.userId)
  rc.set('userRole', values.userRole)
  return rc
}

describe('listTasksTool', () => {
  it('has correct id and description', () => {
    expect(listTasksTool.id).toBe('crm.list_tasks')
    expect(listTasksTool.description).toBeTruthy()
  })

  it('has requestContextSchema defined', () => {
    expect(listTasksTool.requestContextSchema).toBeDefined()
  })

  it('executes and returns an array', async () => {
    const observe = makeObserve()
    const result = await listTasksTool.execute?.(
      { customerId: '550e8400-e29b-41d4-a716-446655440000' },
      { requestContext: makeRequestContext(mockContext), observe } as any,
    )
    expect(Array.isArray(result)).toBe(true)
  })
})

describe('myOpenItemsTool', () => {
  it('has correct id and description', () => {
    expect(myOpenItemsTool.id).toBe('crm.my_open_items')
    expect(myOpenItemsTool.description).toBeTruthy()
  })

  it('has requestContextSchema defined', () => {
    expect(myOpenItemsTool.requestContextSchema).toBeDefined()
  })

  it('executes and returns tasks and followups', async () => {
    const observe = makeObserve()
    const result = await myOpenItemsTool.execute?.(
      {},
      { requestContext: makeRequestContext(mockContext), observe } as any,
    )
    expect(result).toHaveProperty('tasks')
    expect(result).toHaveProperty('followups')
    expect(Array.isArray((result as any).tasks)).toBe(true)
    expect(Array.isArray((result as any).followups)).toBe(true)
  })
})
