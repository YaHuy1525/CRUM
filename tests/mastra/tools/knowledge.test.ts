import { describe, it, expect, vi } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { TenantRequestContext } from '../../../src/mastra/tenant-context'
import { knowledgeRetrieveTool } from '../../../src/mastra/tools/knowledge'

vi.mock('../../../src/db/queries', () => ({
  queryKnowledgeDocuments: vi.fn().mockResolvedValue([
    { id: 'k1', tenant_id: '550e8400-e29b-41d4-a716-446655440000', title: 'Doc 1', content: 'Content', created_at: '2024-01-01', updated_at: '2024-01-01' },
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

describe('knowledgeRetrieveTool', () => {
  it('has correct id and description', () => {
    expect(knowledgeRetrieveTool.id).toBe('knowledge.retrieve')
    expect(knowledgeRetrieveTool.description).toBeTruthy()
  })

  it('has requestContextSchema defined', () => {
    expect(knowledgeRetrieveTool.requestContextSchema).toBeDefined()
  })

  it('executes and returns an array', async () => {
    const observe = makeObserve()
    const result = await knowledgeRetrieveTool.execute?.(
      { query: 'test' },
      { requestContext: makeRequestContext(mockContext), observe } as any,
    )
    expect(Array.isArray(result)).toBe(true)
  })
})
