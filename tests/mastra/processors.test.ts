import { describe, it, expect } from 'vitest'
import { ModerationProcessor } from '@mastra/core/processors'
import {
  crumInputProcessors,
  crumOutputProcessors,
} from '../../src/mastra/processors'

/** The guardrail is subclassed on the output side, so match on the base class. */
function findModeration(processors: unknown[]) {
  return processors.find((p) => p instanceof ModerationProcessor)
}

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

  it('output pipeline contains a moderation guardrail', () => {
    expect(findModeration(crumOutputProcessors)).toBeDefined()
  })

  it('output moderation judges windows of text instead of every delta', () => {
    // One moderation request per text-delta is the framework default, and it is what
    // stalled the chat: a measured turn streamed 232 deltas and ran past 19 minutes
    // without a finish event. The gate judges a window of characters at a time, so a
    // version bump that loses the window brings the stall back.
    const moderation = findModeration(crumOutputProcessors) as unknown as
      | { windowChars?: number }
      | undefined
    expect(typeof moderation?.windowChars).toBe('number')
    expect(moderation!.windowChars!).toBeGreaterThan(0)
  })

  it('TokenLimiter is last in input pipeline', () => {
    const lastProcessor = crumInputProcessors[crumInputProcessors.length - 1]
    expect(lastProcessor!.constructor.name).toBe('TokenLimiterProcessor')
  })
})
