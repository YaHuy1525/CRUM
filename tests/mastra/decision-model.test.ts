import { describe, it, expect, afterEach } from 'vitest'
import { crumDecisionModel } from '../../src/mastra/decision-model'

describe('crumDecisionModel', () => {
  const savedEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...savedEnv }
  })

  it('returns undefined when neither TYPESAFE_AI_API_KEY nor JEV_API_KEY is set', () => {
    delete process.env.TYPESAFE_AI_API_KEY
    delete process.env.JEV_API_KEY
    expect(crumDecisionModel()).toBeUndefined()
  })

  it('returns undefined when both keys are empty strings', () => {
    process.env.TYPESAFE_AI_API_KEY = '  '
    process.env.JEV_API_KEY = ''
    expect(crumDecisionModel()).toBeUndefined()
  })

  it('returns a decision model when TYPESAFE_AI_API_KEY is set', () => {
    process.env.TYPESAFE_AI_API_KEY = 'a'.repeat(32)
    const model = crumDecisionModel()
    expect(model).toBeDefined()
  })

  it('falls back to JEV_API_KEY when TYPESAFE_AI_API_KEY is unset', () => {
    delete process.env.TYPESAFE_AI_API_KEY
    process.env.JEV_API_KEY = 'b'.repeat(32)
    const model = crumDecisionModel()
    expect(model).toBeDefined()
  })

  it('prefers TYPESAFE_AI_API_KEY over JEV_API_KEY', () => {
    process.env.TYPESAFE_AI_API_KEY = 'a'.repeat(32)
    process.env.JEV_API_KEY = 'b'.repeat(32)
    const model = crumDecisionModel()
    expect(model).toBeDefined()
  })
})
