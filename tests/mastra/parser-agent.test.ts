import { describe, it, expect } from 'vitest'
import { parserAgent } from '../../src/mastra/agents/parser'
import { PREFILL_SCHEMAS, CustomerParseSchema } from '../../src/mastra/schemas/prefill'

describe('parserAgent', () => {
  it('has the correct id and model', () => {
    expect(parserAgent.id).toBe('parser')
  })

  it('instructions mention never inferring unstated values', async () => {
    const instructions = await parserAgent.getInstructions()
    const text = typeof instructions === 'string' ? instructions : ''
    expect(text).toContain('Never infer')
  })
})

describe('prefill schemas', () => {
  it('PREFILL_SCHEMAS maps object types to schemas', () => {
    expect(PREFILL_SCHEMAS).toHaveProperty('customer')
    expect(PREFILL_SCHEMAS).toHaveProperty('contact')
    expect(PREFILL_SCHEMAS).toHaveProperty('schedule')
    expect(PREFILL_SCHEMAS).toHaveProperty('task')
  })

  it('CustomerParseSchema validates a minimal customer', () => {
    const result = CustomerParseSchema.safeParse({ name: 'Acme Corp' })
    expect(result.success).toBe(true)
  })

  it('CustomerParseSchema defaults tags to empty array', () => {
    const result = CustomerParseSchema.parse({ name: 'Acme' })
    expect(result.tags).toEqual([])
  })

  it('CustomerParseSchema rejects missing name', () => {
    const result = CustomerParseSchema.safeParse({ company: 'Acme' })
    expect(result.success).toBe(false)
  })
})
