import { describe, it, expect, beforeAll } from 'vitest'

// Set the API key before the workflow module (and transitively the classifier)
// is evaluated. crumDecisionModel() runs at module load time and the Classifier
// constructor reads model.provider — without a key the import throws.
beforeAll(() => {
  process.env.TYPESAFE_AI_API_KEY = 'test-key-for-classifiers-' + 'a'.repeat(32)
})

describe('intentTriageFlow', () => {
  // Dynamic import so the env var is set before module evaluation.
  // Cache the result to avoid repeated imports.
  let flow: Awaited<ReturnType<typeof import('../../src/mastra/workflows/intent-triage')>>['intentTriageFlow']

  beforeAll(async () => {
    const mod = await import('../../src/mastra/workflows/intent-triage')
    flow = mod.intentTriageFlow
  }, 15000)

  it('has the correct id', () => {
    expect(flow.id).toBe('crum-intent-triage')
  })

  it('has an input schema requiring message', () => {
    const result = flow.inputSchema.safeParse({ message: 'Schedule a meeting Thursday 2 to 3' })
    expect(result.success).toBe(true)
  })

  it('rejects input without message', () => {
    const result = flow.inputSchema.safeParse({})
    expect(result.success).toBe(false)
  })
})
