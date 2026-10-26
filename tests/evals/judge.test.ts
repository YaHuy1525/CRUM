import { describe, it, expect, vi, beforeEach } from 'vitest'

// The chat path now falls back to OPENROUTER_API_KEY, and vitest workers can
// carry a real .env value loaded by another suite file (load-env.ts mutates
// process.env for the whole worker). Every case stubs it explicitly so these
// assertions describe the resolver, not the machine they run on.
const NO_CHAT_KEYS = { JUDGE_CHAT_API_KEY: '', OPENROUTER_API_KEY: '' } as const

describe('buildJudge', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('returns null when no judge key is configured', async () => {
    vi.stubEnv('JUDGE_PROVIDER', '')
    vi.stubEnv('JEV_API_KEY', '')
    for (const [k, v] of Object.entries(NO_CHAT_KEYS)) vi.stubEnv(k, v)
    const { buildJudge } = await import('../../src/evals/judge')
    expect(buildJudge()).toBeNull()
  })

  it('returns a judge config on the chat path when JUDGE_CHAT_API_KEY is set', async () => {
    vi.stubEnv('JUDGE_PROVIDER', '')
    vi.stubEnv('JEV_API_KEY', '')
    vi.stubEnv('OPENROUTER_API_KEY', '')
    vi.stubEnv('JUDGE_CHAT_BASE_URL', 'https://openrouter.ai/api/v1')
    vi.stubEnv('JUDGE_CHAT_MODEL', 'openai/gpt-6-luna')
    vi.stubEnv('JUDGE_CHAT_API_KEY', 'b'.repeat(32))
    const { buildJudge } = await import('../../src/evals/judge')
    const judge = buildJudge()
    expect(judge).not.toBeNull()
    expect(judge!.instructions).toContain('expert evaluator')
    expect(judge!.maxProcessorRetries).toBe(2)
    expect(judge!.errorProcessors).toHaveLength(1)
  })

  it('falls back to OPENROUTER_API_KEY as the chat judge key', async () => {
    vi.stubEnv('JUDGE_PROVIDER', '')
    vi.stubEnv('JEV_API_KEY', '')
    vi.stubEnv('JUDGE_CHAT_API_KEY', '')
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-v1-test')
    const { buildJudge } = await import('../../src/evals/judge')
    expect(buildJudge()).not.toBeNull()
  })

  it('prefers the chat path over jev when both keys exist', async () => {
    // The jev path cannot answer chat prompts (§6.5.2, probed 404) — silently
    // preferring it starved every native scorer of scores.
    vi.stubEnv('JUDGE_PROVIDER', 'jev')
    vi.stubEnv('JUDGE_MODEL', 'jev-latest')
    vi.stubEnv('JEV_API_KEY', 'a'.repeat(32))
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-v1-test')
    const { buildJudge } = await import('../../src/evals/judge')
    expect(buildJudge()).not.toBeNull()
  })

  it('still builds the legacy jev judge when only JEV is configured', async () => {
    vi.stubEnv('JUDGE_PROVIDER', 'jev')
    vi.stubEnv('JUDGE_MODEL', 'jev-latest')
    vi.stubEnv('JEV_API_KEY', 'a'.repeat(32))
    for (const [k, v] of Object.entries(NO_CHAT_KEYS)) vi.stubEnv(k, v)
    const { buildJudge } = await import('../../src/evals/judge')
    expect(buildJudge()).not.toBeNull()
  })
})

describe('isJudgeAvailable', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('returns false when no key is set', async () => {
    vi.stubEnv('JUDGE_PROVIDER', '')
    vi.stubEnv('JEV_API_KEY', '')
    for (const [k, v] of Object.entries(NO_CHAT_KEYS)) vi.stubEnv(k, v)
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
