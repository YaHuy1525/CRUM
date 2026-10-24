import { describe, it, expect, vi } from 'vitest'

describe('schedule lifecycle hooks', () => {
  it('prepare returns threadId from schedule', async () => {
    const { buildScheduleHooks } = await import('../../src/mastra/schedule-hooks')
    const hooks = buildScheduleHooks()
    const result = await hooks.prepare!({
      agentId: 'crm-assistant',
      schedule: { threadId: 'thread-digest' },
    } as any)
    expect(result).toEqual({ threadId: 'thread-digest' })
  })

  it('onFinish is defined and callable', async () => {
    const { buildScheduleHooks } = await import('../../src/mastra/schedule-hooks')
    const hooks = buildScheduleHooks()
    expect(hooks.onFinish).toBeDefined()
    await hooks.onFinish!({ agentId: 'crm-assistant', trigger: {} } as any)
  })

  it('onError is defined and callable', async () => {
    const { buildScheduleHooks } = await import('../../src/mastra/schedule-hooks')
    const hooks = buildScheduleHooks()
    expect(hooks.onError).toBeDefined()
    await hooks.onError!({ agentId: 'crm-assistant', error: new Error('test') } as any)
  })

  it('onAbort is defined and callable', async () => {
    const { buildScheduleHooks } = await import('../../src/mastra/schedule-hooks')
    const hooks = buildScheduleHooks()
    expect(hooks.onAbort).toBeDefined()
    await hooks.onAbort!({ agentId: 'crm-assistant' } as any)
  })
})
