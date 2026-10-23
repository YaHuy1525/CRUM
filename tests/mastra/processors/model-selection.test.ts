import { describe, it, expect } from 'vitest'
import { createModelSelectionProcessor } from '../../../src/mastra/processors/model-selection'

describe('ModelSelectionProcessor', () => {
  it('creates a processor with default and fallback models', () => {
    const processor = createModelSelectionProcessor()
    expect(processor).toBeDefined()
  })
})
