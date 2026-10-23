import { SamplingStrategyType, type SamplingStrategy } from '@mastra/observability'
import type { ScoringSamplingConfig } from '@mastra/core/evals'
import { describe, expect, it } from 'vitest'

// TECHNICAL_PLAN.md §7.2.1 and §8.1. Two look-alike sampling declarations whose
// object types are not interchangeable in either direction. Getting them
// backwards is the single most likely error in this codebase because both are
// spelled { type: 'ratio', ... }. The `type` tag alone is asymmetric rather than
// symmetric, which `accepts the enum member` below demonstrates and which
// §7.2.1 currently claims otherwise.
//
//   @mastra/observability  SamplingStrategyType   a real enum, field `probability`
//   @mastra/core/evals     ScoringSamplingConfig  a literal union, field `rate`

describe('observability sampling is an enum taking probability', () => {
  it('accepts the enum member', () => {
    const strategy: SamplingStrategy = {
      type: SamplingStrategyType.RATIO,
      probability: 0.1,
    }
    expect(strategy.type).toBe('ratio')
  })

  it('rejects the string literal', () => {
    // @ts-expect-error SamplingStrategyType is an enum; the literal 'ratio' is a TS2322 here.
    const wrong: SamplingStrategy = { type: 'ratio', probability: 0.1 }
    void wrong
  })

  it('rejects the scorer field name', () => {
    // @ts-expect-error The observability field is `probability`, not `rate`.
    const wrong: SamplingStrategy = { type: SamplingStrategyType.RATIO, rate: 0.1 }
    void wrong
  })
})

describe('scoring sampling is a literal union taking rate', () => {
  it('accepts the literal and the rate field', () => {
    const sampling: ScoringSamplingConfig = { type: 'ratio', rate: 1 }
    expect(sampling.type).toBe('ratio')
  })

  it('accepts the none variant', () => {
    const sampling: ScoringSamplingConfig = { type: 'none' }
    expect(sampling.type).toBe('none')
  })

  it('accepts the enum member, because a string enum widens to its literal', () => {
    // Asymmetric, and the reverse of what §7.2.1 assumes. A TypeScript string
    // enum member IS assignable to its underlying string literal type, so
    // SamplingStrategyType.RATIO satisfies ScoringSamplingConfig's type field.
    // The literal 'ratio' is NOT assignable to SamplingStrategyType, which is
    // what the observability block above proves. The trap that actually bit v0.2
    // of the spec is the field name, probability against rate, and both of those
    // assertions do fire in both directions.
    const sampling: ScoringSamplingConfig = { type: SamplingStrategyType.RATIO, rate: 1 }
    expect(sampling.type).toBe('ratio')
  })

  it('rejects the observability field name', () => {
    // @ts-expect-error The scoring field is `rate`, not `probability`.
    const wrong: ScoringSamplingConfig = { type: 'ratio', probability: 0.1 }
    void wrong
  })
})

describe('the enum is closed', () => {
  it('has exactly the four documented members', () => {
    expect(Object.values(SamplingStrategyType).sort()).toEqual([
      'always',
      'custom',
      'never',
      'ratio',
    ])
  })
})
