import { describe, it, expect } from 'vitest'
import {
  createContactTool,
  createScheduleTool,
  transferOwnerTool,
  sendMailTool,
} from '../../../src/mastra/tools/approval-writes'

describe('approval-class tools (contact, schedule, transfer, mail)', () => {
  it('createContactTool has correct id and requireApproval', () => {
    expect(createContactTool.id).toBe('crm.create_contact')
    expect(typeof createContactTool.requireApproval).toBe('function')
    expect(createContactTool.outputValidation).toBe('warn')
  })

  it('createScheduleTool has correct id and requireApproval', () => {
    expect(createScheduleTool.id).toBe('crm.create_schedule')
    expect(typeof createScheduleTool.requireApproval).toBe('function')
    expect(createScheduleTool.outputValidation).toBe('warn')
  })

  it('transferOwnerTool has correct id and requireApproval', () => {
    expect(transferOwnerTool.id).toBe('crm.transfer_owner')
    expect(typeof transferOwnerTool.requireApproval).toBe('function')
    expect(transferOwnerTool.outputValidation).toBe('warn')
  })

  it('sendMailTool has correct id and requireApproval', () => {
    expect(sendMailTool.id).toBe('mail.send')
    expect(typeof sendMailTool.requireApproval).toBe('function')
    expect(sendMailTool.outputValidation).toBe('warn')
  })
})
