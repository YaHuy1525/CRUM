import { ModelRouterEmbeddingModel } from '@mastra/core/llm'
import type { OpenAICompatibleConfig } from '@mastra/core/llm'
import { parseEnv } from '../config/env'

export const EMBEDDING_MODEL_ID = 'openai/text-embedding-3-small'
export const EMBEDDING_DIMENSIONS = 1536

// modelId lets callers override the embedding model (env.MASTRA_MEMORY_EMBEDDER,
// wired by the recall factory); unset keeps the CRUM default. The template-literal
// type matches OpenAICompatibleConfig.id: 'provider/model' ids only.
export function crumEmbeddingModel(
  modelId: `${string}/${string}` = EMBEDDING_MODEL_ID,
): ModelRouterEmbeddingModel {
  const env = parseEnv()
  const url = (env.EMBEDDING_BASE_URL ?? '').trim()
  const apiKey = (env.EMBEDDING_API_KEY ?? process.env.MODEL_API_KEY ?? '').trim()

  if (url === '') return new ModelRouterEmbeddingModel(modelId)

  const config: OpenAICompatibleConfig = {
    id: modelId,
    url: url.replace(/\/$/, ''),
    ...(apiKey !== '' ? { apiKey } : {}),
  }
  return new ModelRouterEmbeddingModel(config)
}
