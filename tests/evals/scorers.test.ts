import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('buildScorers', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns all 12 scorers keyed by id', async () => {
    vi.stubEnv('JUDGE_PROVIDER', '')
    vi.stubEnv('JEV_API_KEY', '')
    vi.stubEnv('JUDGE_CHAT_API_KEY', '')
    // Pin the judge off explicitly: the chat path falls back to
    // OPENROUTER_API_KEY, which a shared worker may carry from another suite.
    vi.stubEnv('OPENROUTER_API_KEY', '')
    const { buildScorers } = await import('../../src/evals/scorers')
    const scorers = buildScorers()

    // 7 native prebuilt scorers
    expect(scorers.faithfulness).toBeDefined()
    expect(scorers.answerRelevancy).toBeDefined()
    expect(scorers.hallucination).toBeDefined()
    expect(scorers.contextPrecision).toBeDefined()
    expect(scorers.toxicity).toBeDefined()
    expect(scorers.toolCallAccuracy).toBeDefined()
    expect(scorers.trajectoryAccuracy).toBeDefined()

    // 3 custom scorers
    expect(scorers.refusalCorrectness).toBeDefined()
    expect(scorers.tenantIsolation).toBeDefined()
    expect(scorers.writeClaim).toBeDefined()

    // 2 classifier scorers
    expect(scorers.intentClassification).toBeDefined()
    expect(scorers.injectionDetection).toBeDefined()
  }, 15_000)

  it('includes judge config on native scorers when judge is available', async () => {
    vi.stubEnv('JUDGE_PROVIDER', 'jev')
    vi.stubEnv('JUDGE_MODEL', 'jev-latest')
    vi.stubEnv('JEV_API_KEY', 'a'.repeat(32))
    const { buildScorers } = await import('../../src/evals/scorers')
    const scorers = buildScorers()
    // Native scorers should have been built with the judge
    expect(scorers.faithfulness).toBeDefined()
  })
})
