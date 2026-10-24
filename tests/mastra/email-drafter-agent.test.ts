import { describe, it, expect } from 'vitest'
import { emailDrafterAgent } from '../../src/mastra/agents/email-drafter'

describe('emailDrafterAgent', () => {
  it('has the correct id', () => {
    expect(emailDrafterAgent.id).toBe('email-drafter')
  })

  it('instructions mention never sending', async () => {
    const instructions = await emailDrafterAgent.getInstructions()
    const text = typeof instructions === 'string' ? instructions : ''
    expect(text).toContain('Never send')
  })

  it('has no tools', async () => {
    const tools = await emailDrafterAgent.getToolsForExecution({})
    expect(tools).toEqual({})
  })
})
