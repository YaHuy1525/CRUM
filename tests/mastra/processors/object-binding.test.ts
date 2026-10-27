import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { MastraDBMessage } from '@mastra/core/agent'
import type { ProcessInputStepArgs } from '@mastra/core/processors'
import type { TenantRequestContext } from '../../../src/mastra/tenant-context'

// Mock the queries module
const mockQueryCustomer = vi.fn()
vi.mock('../../../src/db/queries', () => ({
  queryCustomer: mockQueryCustomer,
}))

function makeMessage(overrides: Partial<MastraDBMessage> = {}): MastraDBMessage {
  return {
    id: 'msg-1',
    role: 'user',
    createdAt: new Date(),
    content: {
      format: 2,
      parts: [{ type: 'text', text: 'Tell me about this customer' }],
    },
    ...overrides,
  }
}

function makeArgs(overrides: {
  requestContext?: RequestContext
  messages?: MastraDBMessage[]
  systemMessages?: ProcessInputStepArgs['systemMessages']
} = {}): ProcessInputStepArgs {
  const requestContext = overrides.requestContext ?? new RequestContext()
  const messages = overrides.messages ?? [makeMessage()]
  const systemMessages = overrides.systemMessages ?? []
  return {
    requestContext,
    messages,
    systemMessages,
    stepNumber: 0,
    steps: [],
    state: {},
    retryCount: 0,
    // Minimal stubs for required fields the processor does not use. The member
    // type is read off ProcessInputStepArgs so these carry a real type instead of
    // `any`; the whole literal is then projected onto the argument type.
    abort: vi.fn(),
    messageList: {} as ProcessInputStepArgs['messageList'],
    model: {} as ProcessInputStepArgs['model'],
  } as unknown as ProcessInputStepArgs
}

describe('ObjectBindingProcessor', () => {
  beforeEach(() => {
    vi.resetModules()
    mockQueryCustomer.mockReset()
  })

  it('loads the bound customer and injects it as a system message', async () => {
    const { ObjectBindingProcessor } = await import(
      '../../../src/mastra/processors/object-binding'
    )
    const processor = new ObjectBindingProcessor()

    const tenantContext: TenantRequestContext = {
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '660e8400-e29b-41d4-a716-446655440001',
      userRole: 'user',
    }
    const customer = {
      id: '770e8400-e29b-41d4-a716-446655440002',
      tenant_id: tenantContext.tenantId,
      name: 'Acme Corp',
      city: 'Springfield',
      owner_id: tenantContext.userId,
      team_member_ids: [],
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    }
    mockQueryCustomer.mockResolvedValue(customer)

    const requestContext = new RequestContext()
    requestContext.setRaw('tenantContext', tenantContext)
    requestContext.setRaw('objectBinding', {
      type: 'customer',
      id: '770e8400-e29b-41d4-a716-446655440002',
    })

    const result = await processor.processInputStep(makeArgs({ requestContext }))

    expect(mockQueryCustomer).toHaveBeenCalledWith(
      tenantContext,
      '770e8400-e29b-41d4-a716-446655440002',
    )
    expect(result).toBeDefined()
    const systemMessages = result?.systemMessages
    expect(systemMessages).toBeDefined()
    expect(systemMessages?.length).toBe(1)
    const sys = systemMessages?.[0]
    expect(sys).toBeDefined()
    expect(sys?.role).toBe('system')
    const content = sys?.content
    // This processor emits plain-text system content; the array form is the
    // framework's generic content shape, so read text from either branch without
    // falling back to `any`.
    const text =
      typeof content === 'string'
        ? content
        : (content as unknown as { type?: unknown; text?: unknown }[])
            .filter((p) => p.type === 'text')
            .map((p) => (typeof p.text === 'string' ? p.text : ''))
            .join('')
    expect(text).toContain('Acme Corp')
    expect(text).toContain('770e8400-e29b-41d4-a716-446655440002')
  })

  it('passes through when no object binding is present', async () => {
    const { ObjectBindingProcessor } = await import(
      '../../../src/mastra/processors/object-binding'
    )
    const processor = new ObjectBindingProcessor()

    const tenantContext: TenantRequestContext = {
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '660e8400-e29b-41d4-a716-446655440001',
      userRole: 'user',
    }
    const requestContext = new RequestContext()
    requestContext.setRaw('tenantContext', tenantContext)

    const messages = [makeMessage()]
    const systemMessages = [{ role: 'system' as const, content: 'Existing instruction' }]

    const result = await processor.processInputStep(
      makeArgs({ requestContext, messages, systemMessages }),
    )

    expect(mockQueryCustomer).not.toHaveBeenCalled()
    // No change: returning undefined signals pass-through
    expect(result).toBeUndefined()
  })

  it('passes through when customer is not found', async () => {
    const { ObjectBindingProcessor } = await import(
      '../../../src/mastra/processors/object-binding'
    )
    const processor = new ObjectBindingProcessor()

    const tenantContext: TenantRequestContext = {
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '660e8400-e29b-41d4-a716-446655440001',
      userRole: 'user',
    }
    mockQueryCustomer.mockResolvedValue(null)

    const requestContext = new RequestContext()
    requestContext.setRaw('tenantContext', tenantContext)
    requestContext.setRaw('objectBinding', {
      type: 'customer',
      id: 'missing-id',
    })

    const result = await processor.processInputStep(makeArgs({ requestContext }))

    expect(mockQueryCustomer).toHaveBeenCalled()
    expect(result).toBeUndefined()
  })
})
