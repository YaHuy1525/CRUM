import { describe, it, expect, beforeAll } from 'vitest'

// Set the API key before any classifier module is imported. The classifiers
// call crumDecisionModel() at module load time, which returns undefined when
// no key is present and throws on the `model!` non-null assertion.
beforeAll(() => {
  process.env.TYPESAFE_AI_API_KEY = 'test-key-for-classifiers-' + 'a'.repeat(32)
})

describe('intentClassifier', () => {
  // Dynamic imports so the env var is set before module evaluation.
  const getIntentClassifier = () =>
    import('../../src/mastra/classifiers/intent').then((m) => m.intentClassifier)

  it('has the correct id', async () => {
    const intentClassifier = await getIntentClassifier()
    expect(intentClassifier.id).toBe('crum-intent')
  })

  it('has intent (choice) and hasTimeRange (boolean) questions', async () => {
    const intentClassifier = await getIntentClassifier()
    const questions = intentClassifier.questions
    expect(questions).toHaveProperty('intent')
    expect(questions).toHaveProperty('hasTimeRange')
  })

  it('intent question has schedule, task, other criteria', async () => {
    const intentClassifier = await getIntentClassifier()
    const intent = intentClassifier.questions.intent as {
      type: string
      criteria: Record<string, string>
    }
    expect(intent.type).toBe('choice')
    expect(intent.criteria).toHaveProperty('schedule')
    expect(intent.criteria).toHaveProperty('task')
    expect(intent.criteria).toHaveProperty('other')
  })

  it('hasTimeRange question is boolean', async () => {
    const intentClassifier = await getIntentClassifier()
    const htr = intentClassifier.questions.hasTimeRange as { type: string }
    expect(htr.type).toBe('boolean')
  })
})

describe('injectionClassifier', () => {
  const getInjectionClassifier = () =>
    import('../../src/mastra/classifiers/injection').then(
      (m) => m.injectionClassifier,
    )

  it('has the correct id', async () => {
    const injectionClassifier = await getInjectionClassifier()
    expect(injectionClassifier.id).toBe('crum-injection')
  })

  it('has injection (boolean) question', async () => {
    const injectionClassifier = await getInjectionClassifier()
    const questions = injectionClassifier.questions
    expect(questions).toHaveProperty('injection')
  })

  it('injection question is boolean with true/false criteria', async () => {
    const injectionClassifier = await getInjectionClassifier()
    const injection = injectionClassifier.questions.injection as {
      type: string
      criteria: Record<string, string>
    }
    expect(injection.type).toBe('boolean')
    expect(injection.criteria).toHaveProperty('true')
    expect(injection.criteria).toHaveProperty('false')
  })
})
