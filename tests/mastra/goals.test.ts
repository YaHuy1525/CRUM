// tests/mastra/goals.test.ts
import { describe, it, expect, vi } from 'vitest'

describe('startInboxClearingGoal', () => {
  it('calls setObjective with maxRuns 12 and judge model', async () => {
    const setObjective = vi.fn().mockResolvedValue({ id: 'goal-1', status: 'active' })
    const mockAgent = { setObjective }

    const { startInboxClearingGoal } = await import('../../src/mastra/goals')
    await startInboxClearingGoal(mockAgent as any, {
      threadId: 'thread-1',
      resourceId: 'tenant_1:user_1',
    })

    expect(setObjective).toHaveBeenCalledOnce()
    const [objective, opts] = setObjective.mock.calls[0]!
    expect(objective).toContain('approval-free')
    expect(opts.maxRuns).toBe(12)
    expect(opts.threadId).toBe('thread-1')
    expect(opts.resourceId).toBe('tenant_1:user_1')
    expect(opts.judgeModelId).toBeDefined()
  })

  it('objective text mentions inbox clearing scope', async () => {
    const setObjective = vi.fn().mockResolvedValue({ id: 'goal-1', status: 'active' })
    const mockAgent = { setObjective }

    const { startInboxClearingGoal } = await import('../../src/mastra/goals')
    await startInboxClearingGoal(mockAgent as any, {
      threadId: 'thread-1',
      resourceId: 'tenant_1:user_1',
    })

    const [objective] = setObjective.mock.calls[0]!
    expect(objective).toMatch(/followup|inbox|clear/i)
  })
})
