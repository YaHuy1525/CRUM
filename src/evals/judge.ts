import { createOpenAI } from '@ai-sdk/openai'
import { StreamErrorRetryProcessor } from '@mastra/core/processors'
import type { LanguageModel } from 'ai'

const JUDGE_INSTRUCTIONS = `You are an expert evaluator. Score the response against the criteria.
Return a score and a concise reason explaining the score.
Be strict but fair. A perfect score requires meeting every criterion.`

function getEnv(name: string): string | undefined {
  const v = process.env[name]
  return v && v.trim() !== '' ? v : undefined
}

function buildRetryProcessor(): StreamErrorRetryProcessor {
  return new StreamErrorRetryProcessor({
    maxRetries: 2,
    maxRetryAfterMs: 30_000,
    delayMs: ({ retryCount }) => Math.min(1_000 * 2 ** retryCount, 30_000),
    matchers: [
      (error: unknown) =>
        error instanceof Error &&
        /ECONNRESET|ETIMEDOUT|socket hang up/i.test(error.message),
    ],
    retryUnknownErrors: false,
  })
}

function buildJudgeModel(): LanguageModel | null {
  const chatKey = getEnv('JUDGE_CHAT_API_KEY') ?? getEnv('OPENROUTER_API_KEY')
  if (chatKey) {
    const baseUrl = getEnv('JUDGE_CHAT_BASE_URL') ?? 'https://openrouter.ai/api/v1'
    const model = getEnv('JUDGE_CHAT_MODEL') ?? 'openai/gpt-4o-mini'
    const openai = createOpenAI({ apiKey: chatKey, baseURL: baseUrl })
    return openai(model)
  }

  if (getEnv('JUDGE_PROVIDER') === 'jev') {
    const apiKey = getEnv('JEV_API_KEY')
    if (!apiKey) return null
    const model = getEnv('JUDGE_MODEL') ?? 'jev-latest'
    const baseUrl = getEnv('JUDGE_CHAT_BASE_URL') ?? 'https://api.typesafe.ai/v1'
    const openai = createOpenAI({ apiKey, baseURL: baseUrl })
    return openai(model)
  }

  return null
}

export interface JudgeConfig {
  model: LanguageModel
  instructions: string
  errorProcessors: StreamErrorRetryProcessor[]
  maxProcessorRetries: number
}

export function buildJudge(): JudgeConfig | null {
  const model = buildJudgeModel()
  if (!model) return null
  return {
    model,
    instructions: JUDGE_INSTRUCTIONS,
    errorProcessors: [buildRetryProcessor()],
    maxProcessorRetries: 2,
  }
}

export function isJudgeAvailable(): boolean {
  return buildJudge() !== null
}
