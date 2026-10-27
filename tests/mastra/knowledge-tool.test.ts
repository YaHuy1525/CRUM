import { describe, it, expect } from 'vitest'
import { knowledgeRetrieveTool } from '../../src/mastra/tools/knowledge'

describe('knowledgeRetrieveTool', () => {
  it('has the correct tool id', () => {
    expect(knowledgeRetrieveTool).toBeDefined()
    expect(knowledgeRetrieveTool.id).toBe('knowledge.retrieve')
  })

  it('has a description mentioning citations and tenant scope', () => {
    expect(knowledgeRetrieveTool.description).toContain('citation')
    expect(knowledgeRetrieveTool.description).toContain('tenant')
  })
})
