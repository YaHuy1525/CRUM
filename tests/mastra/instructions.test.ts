import { describe, it, expect } from 'vitest'
import { CRUM_INSTRUCTIONS } from '../../src/mastra/instructions'
import { CRUM_WORKING_MEMORY_TEMPLATE } from '../../src/mastra/working-memory'

describe('CRUM instruction block', () => {
  it('contains the role section', () => {
    expect(CRUM_INSTRUCTIONS).toContain('<header role="presentation">')
    expect(CRUM_INSTRUCTIONS).toContain('CRUM, a conversational CRM')
  })

  it('contains the rules section with tool-use mandate', () => {
    expect(CRUM_INSTRUCTIONS).toContain('<section id="rules">')
    expect(CRUM_INSTRUCTIONS).toContain('Access and change data only through tools')
  })

  it('explains the why behind each rule', () => {
    // Claude prompting best practices: models generalize better from rules
    // with stated motivation, so every rule article carries a rationale.
    const articles = CRUM_INSTRUCTIONS.match(/<article>\s*<h3>/g) ?? []
    const whys = CRUM_INSTRUCTIONS.match(/<p class="why">/g) ?? []
    expect(articles.length).toBeGreaterThanOrEqual(5)
    expect(whys.length).toEqual(articles.length)
  })

  it('carries worked examples wrapped distinctly from instructions', () => {
    expect(CRUM_INSTRUCTIONS).toContain('<article class="example">')
    const examples = CRUM_INSTRUCTIONS.match(/<article class="example">/g) ?? []
    expect(examples.length).toBeGreaterThanOrEqual(3)
    expect(examples.length).toBeLessThanOrEqual(5)
  })

  it('contains the system-reminders section', () => {
    expect(CRUM_INSTRUCTIONS).toContain('<system-reminder>...</system-reminder>')
  })

  it('contains the output-format section', () => {
    expect(CRUM_INSTRUCTIONS).toContain('<section id="output_format">')
    expect(CRUM_INSTRUCTIONS).toContain('concise prose')
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
