import { describe, it, expect } from 'vitest'
import { ingestWorkflow, parseStep, ingestStep } from '../../src/mastra/workflows/ingest'

describe('ingestWorkflow', () => {
  it('is a workflow with id knowledge-ingest', () => {
    expect(ingestWorkflow).toBeDefined()
    expect(ingestWorkflow.id).toBe('knowledge-ingest')
  })

  it('has parseStep and ingestStep as steps', () => {
    expect(parseStep).toBeDefined()
    expect(parseStep.id).toBe('parse')
    expect(ingestStep).toBeDefined()
    expect(ingestStep.id).toBe('ingest')
  })
})
