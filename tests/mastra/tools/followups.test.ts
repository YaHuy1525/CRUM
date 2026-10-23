import { describe, it, expect, vi } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { TenantRequestContext } from '../../../src/mastra/tenant-context'
import { listFollowupsTool } from '../../../src/mastra/tools/followups'

vi.mock('../../../src/db/queries', () => ({
  queryFollowups: vi.fn().mockResolvedValue([
    { id: 'f1', tenant_id: '550e8400-e29b-41d4-a716-446655440000', customer_id: 'c1', note: 'Follow up', owner_id: 'u1', team_member_ids: [], created_at: '2024-01-01', updated_at: '2024-01-01' },
  ]),
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

describe('listFollowupsTool', () => {
  it('has correct id and description', () => {
    expect(listFollowupsTool.id).toBe('crm.list_followups')
    expect(listFollowupsTool.description).toBeTruthy()
  })

  it('has requestContextSchema defined', () => {
    expect(listFollowupsTool.requestContextSchema).toBeDefined()
  })

  it('executes and returns an array', async () => {
    const observe = makeObserve()
    const result = await listFollowupsTool.execute?.(
      { customerId: '550e8400-e29b-41d4-a716-446655440000' },
      { requestContext: makeRequestContext(mockContext), observe } as any,
    )
    expect(Array.isArray(result)).toBe(true)
  })
})
