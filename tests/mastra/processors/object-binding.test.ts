import { describe, it, expect } from 'vitest'
import { ObjectBindingProcessor } from '../../../src/mastra/processors/object-binding'

describe('ObjectBindingProcessor', () => {
  it('constructs with default options', () => {
    const processor = new ObjectBindingProcessor()
    expect(processor).toBeDefined()
    expect(processor.id).toBe('object-binding-processor')
  })

  it('has processInputStep method', () => {
    const processor = new ObjectBindingProcessor()
    expect(typeof processor.processInputStep).toBe('function')
  })
})
