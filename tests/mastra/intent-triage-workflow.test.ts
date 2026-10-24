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
  type TriageModule = typeof import('../../src/mastra/workflows/intent-triage')
  let flow: TriageModule['intentTriageFlow']

  beforeAll(async () => {
    const mod = await import('../../src/mastra/workflows/intent-triage')
    flow = mod.intentTriageFlow
  }, 15000)

  it('has the correct id', () => {
    expect(flow.id).toBe('crum-intent-triage')
  })

  it('has an input schema requiring message', async () => {
    const result = await flow.inputSchema['~standard'].validate({
      message: 'Schedule a meeting Thursday 2 to 3',
    })
    expect(result.issues).toBeUndefined()
  })

  it('rejects input without message', async () => {
    const result = await flow.inputSchema['~standard'].validate({})
    expect(result.issues).toBeDefined()
  })
})
