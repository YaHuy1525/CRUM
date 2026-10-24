import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('buildJudge', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns null when no judge key is configured', async () => {
    vi.stubEnv('JUDGE_PROVIDER', '')
    vi.stubEnv('JEV_API_KEY', '')
    vi.stubEnv('JUDGE_CHAT_API_KEY', '')
    const { buildJudge } = await import('../../src/evals/judge')
    expect(buildJudge()).toBeNull()
  })

  it('returns a judge config when JEV_API_KEY is set', async () => {
    vi.stubEnv('JUDGE_PROVIDER', 'jev')
    vi.stubEnv('JUDGE_MODEL', 'jev-latest')
    vi.stubEnv('JEV_API_KEY', 'a'.repeat(32))
    const { buildJudge } = await import('../../src/evals/judge')
    const judge = buildJudge()
    expect(judge).not.toBeNull()
    expect(judge!.instructions).toContain('expert evaluator')
    expect(judge!.maxProcessorRetries).toBe(2)
    expect(judge!.errorProcessors).toHaveLength(1)
  })

  it('returns a judge config when JUDGE_CHAT_API_KEY is set', async () => {
    vi.stubEnv('JUDGE_PROVIDER', '')
    vi.stubEnv('JEV_API_KEY', '')
    vi.stubEnv('JUDGE_CHAT_BASE_URL', 'https://openrouter.ai/api/v1')
    vi.stubEnv('JUDGE_CHAT_MODEL', 'openai/gpt-6-luna')
    vi.stubEnv('JUDGE_CHAT_API_KEY', 'b'.repeat(32))
    const { buildJudge } = await import('../../src/evals/judge')
    const judge = buildJudge()
    expect(judge).not.toBeNull()
  })
})

describe('isJudgeAvailable', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns false when no key is set', async () => {
    vi.stubEnv('JUDGE_PROVIDER', '')
    vi.stubEnv('JEV_API_KEY', '')
    vi.stubEnv('JUDGE_CHAT_API_KEY', '')
    const { isJudgeAvailable } = await import('../../src/evals/judge')
    expect(isJudgeAvailable()).toBe(false)
  })

  it('returns true when a key is set', async () => {
    vi.stubEnv('JUDGE_PROVIDER', 'jev')
    vi.stubEnv('JUDGE_MODEL', 'jev-latest')
    vi.stubEnv('JEV_API_KEY', 'a'.repeat(32))
    const { isJudgeAvailable } = await import('../../src/evals/judge')
    expect(isJudgeAvailable()).toBe(true)
  })
})
