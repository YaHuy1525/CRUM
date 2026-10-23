import { describe, it, expect } from 'vitest'
import { CRUM_INSTRUCTIONS } from '../../src/mastra/instructions'
import { CRUM_WORKING_MEMORY_TEMPLATE } from '../../src/mastra/working-memory'

describe('CRUM instruction block', () => {
  it('contains the identity section', () => {
    expect(CRUM_INSTRUCTIONS).toContain('<identity>')
    expect(CRUM_INSTRUCTIONS).toContain('CRUM, a conversational CRM')
  })

  it('contains the rules section with tool-use mandate', () => {
    expect(CRUM_INSTRUCTIONS).toContain('<rules>')
    expect(CRUM_INSTRUCTIONS).toContain('Access and change data only through tools')
  })

  it('contains the system-reminders section', () => {
    expect(CRUM_INSTRUCTIONS).toContain('<system_reminders>')
  })

  it('contains the output-format section', () => {
    expect(CRUM_INSTRUCTIONS).toContain('<output_format>')
    expect(CRUM_INSTRUCTIONS).toContain('Concise prose')
  })

  it('distinguishes tasks from schedules', () => {
    expect(CRUM_INSTRUCTIONS).toContain('concrete start and end time is a schedule')
  })
})

describe('CRUM working memory template', () => {
  it('is a non-empty string', () => {
    expect(CRUM_WORKING_MEMORY_TEMPLATE.length).toBeGreaterThan(0)
  })

  it('contains user preferences section', () => {
    expect(CRUM_WORKING_MEMORY_TEMPLATE).toContain('user preferences')
  })

  it('contains active filters section', () => {
    expect(CRUM_WORKING_MEMORY_TEMPLATE).toContain('active filters')
  })

  it('contains noted facts section', () => {
    expect(CRUM_WORKING_MEMORY_TEMPLATE).toContain('noted facts')
  })
})
