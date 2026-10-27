import { ModelRouterEmbeddingModel } from '@mastra/core/llm'
import type { OpenAICompatibleConfig } from '@mastra/core/llm'
import { parseEnv } from '../config/env'

export const EMBEDDING_MODEL_ID = 'openai/text-embedding-3-small'
export const EMBEDDING_DIMENSIONS = 1536

export function crumEmbeddingModel(): ModelRouterEmbeddingModel {
  const env = parseEnv()
  const url = (env.EMBEDDING_BASE_URL ?? '').trim()
  const apiKey = (env.EMBEDDING_API_KEY ?? process.env.MODEL_API_KEY ?? '').trim()

  if (url === '') return new ModelRouterEmbeddingModel(EMBEDDING_MODEL_ID)

  const config: OpenAICompatibleConfig = {
    id: EMBEDDING_MODEL_ID,
    url: url.replace(/\/$/, ''),
    ...(apiKey !== '' ? { apiKey } : {}),
  }
  return new ModelRouterEmbeddingModel(config)
}
