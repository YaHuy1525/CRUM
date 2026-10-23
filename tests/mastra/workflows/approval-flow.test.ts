import { describe, it, expect } from 'vitest'
import { approvalFlow } from '../../../src/mastra/workflows/approval-flow'

describe('approvalFlow', () => {
  it('has the correct id', () => {
    expect(approvalFlow.id).toBe('approvalFlow')
  })

  it('has autoRestartActiveRuns set to false', () => {
    // The workflow declaration must set autoRestartActiveRuns: false
    // to prevent blanket restart of half-approved writes. §4.11.4.
    expect(approvalFlow.options.autoRestartActiveRuns).toBe(false)
  })
})
