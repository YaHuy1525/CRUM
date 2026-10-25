import { describe, it, expect } from 'vitest'
import type {
  ScheduleAbortContext,
  ScheduleErrorContext,
  ScheduleFinishContext,
  SchedulePrepareContext,
} from '@mastra/core/schedules'

// Shared hook-context fixtures. Every ScheduleHook context carries mastra,
// agentId, schedule and trigger; the per-hook fields are added at each call.
const trigger = { kind: 'manual' as const, firedAt: new Date() }
const schedule = { id: 'sched-1', agentId: 'crm-assistant' }

describe('schedule lifecycle hooks', () => {
  it('prepare returns threadId from schedule', async () => {
    const { buildScheduleHooks } = await import('../../src/mastra/schedule-hooks')
    const hooks = buildScheduleHooks()
    const ctx: SchedulePrepareContext = {
      mastra: undefined,
      agentId: 'crm-assistant',
      schedule: { ...schedule, threadId: 'thread-digest' },
      trigger,
    }
    const result = await hooks.prepare!(ctx)
    expect(result).toEqual({ threadId: 'thread-digest' })
  })

  it('onFinish is defined and callable', async () => {
    const { buildScheduleHooks } = await import('../../src/mastra/schedule-hooks')
    const hooks = buildScheduleHooks()
    expect(hooks.onFinish).toBeDefined()
    const ctx: ScheduleFinishContext = {
      mastra: undefined,
      agentId: 'crm-assistant',
      schedule,
      trigger,
      outcome: 'succeeded',
      effective: { prompt: 'run digest' },
    }
    await hooks.onFinish!(ctx)
  })

  it('onError is defined and callable', async () => {
    const { buildScheduleHooks } = await import('../../src/mastra/schedule-hooks')
    const hooks = buildScheduleHooks()
    expect(hooks.onError).toBeDefined()
    const ctx: ScheduleErrorContext = {
      mastra: undefined,
      agentId: 'crm-assistant',
      schedule,
      trigger,
      phase: 'run',
      error: new Error('test'),
    }
    await hooks.onError!(ctx)
  })

  it('onAbort is defined and callable', async () => {
    const { buildScheduleHooks } = await import('../../src/mastra/schedule-hooks')
    const hooks = buildScheduleHooks()
    expect(hooks.onAbort).toBeDefined()
    const ctx: ScheduleAbortContext = {
      mastra: undefined,
      agentId: 'crm-assistant',
      schedule,
      trigger,
      runId: 'run-1',
      effective: { prompt: 'run digest' },
    }
    await hooks.onAbort!(ctx)
  })
})
