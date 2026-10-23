import { describe, it, expect } from 'vitest'
import {
  crumInputProcessors,
  crumOutputProcessors,
} from '../../src/mastra/processors'

describe('Processor pipeline assembly', () => {
  it('input pipeline contains TokenLimiter', () => {
    const hasTokenLimiter = crumInputProcessors.some(
      (p) => p.constructor.name === 'TokenLimiterProcessor'
    )
    expect(hasTokenLimiter).toBe(true)
  })

  it('input pipeline contains ObjectBindingProcessor', () => {
    const hasObjectBinding = crumInputProcessors.some(
      (p) => p.constructor.name === 'ObjectBindingProcessor'
    )
    expect(hasObjectBinding).toBe(true)
  })

  it('input pipeline contains EnsureFinalResponseProcessor', () => {
    const hasEnsureFinal = crumInputProcessors.some(
      (p) => p.constructor.name === 'EnsureFinalResponseProcessor'
    )
    expect(hasEnsureFinal).toBe(true)
  })

  it('input pipeline contains ModerationProcessor', () => {
    const hasModeration = crumInputProcessors.some(
      (p) => p.constructor.name === 'ModerationProcessor'
    )
    expect(hasModeration).toBe(true)
  })

  it('output pipeline contains ModerationProcessor', () => {
    const hasModeration = crumOutputProcessors.some(
      (p) => p.constructor.name === 'ModerationProcessor'
    )
    expect(hasModeration).toBe(true)
  })

  it('TokenLimiter is last in input pipeline', () => {
    const lastProcessor = crumInputProcessors[crumInputProcessors.length - 1]
    expect(lastProcessor!.constructor.name).toBe('TokenLimiterProcessor')
  })
})
