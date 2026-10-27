import { describe, it, expect } from 'vitest'
import { logFollowupTool, createTaskTool, draftMailTool } from '../../../src/mastra/tools/auto-writes'

describe('auto-class tools', () => {
  it('logFollowupTool has the correct id and outputValidation', () => {
    expect(logFollowupTool.id).toBe('crm.log_followup')
    expect(logFollowupTool.outputValidation).toBe('warn')
  })

  it('createTaskTool has the correct id and outputValidation', () => {
    expect(createTaskTool.id).toBe('crm.create_task')
    expect(createTaskTool.outputValidation).toBe('warn')
  })

  it('draftMailTool has the correct id and outputValidation', () => {
    expect(draftMailTool.id).toBe('mail.draft')
    expect(draftMailTool.outputValidation).toBe('warn')
  })

  it('none of the auto tools set requireApproval', () => {
    expect(logFollowupTool.requireApproval).toBeFalsy()
    expect(createTaskTool.requireApproval).toBeFalsy()
    expect(draftMailTool.requireApproval).toBeFalsy()
  })
})
