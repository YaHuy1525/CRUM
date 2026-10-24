import { ModelRouterEmbeddingModel } from '@mastra/core/llm'
import type { OpenAICompatibleConfig } from '@mastra/core/llm'
import { parseEnv } from '../config/env'

// Pinned: a known id from EmbeddingModelId, so no dimension override is needed. §6.4.
export const EMBEDDING_MODEL_ID = 'openai/text-embedding-3-small'
export const EMBEDDING_DIMENSIONS = 1536

/**
 * Builds the embedding model from environment. One model, one dimension, one module.
 * Two embedding models in one system means two vector spaces that look
 * interchangeable and are not. §6.4.
 */
export function crumEmbeddingModel(): ModelRouterEmbeddingModel {
  const env = parseEnv()
  const url = (env.EMBEDDING_BASE_URL ?? '').trim()
  const apiKey = (env.EMBEDDING_API_KEY ?? process.env.MODEL_API_KEY ?? '').trim()

  // No custom endpoint: the plain string form, resolved through the model router.
  if (url === '') return new ModelRouterEmbeddingModel(EMBEDDING_MODEL_ID)

  // OpenAI-compatible endpoint (self-hosted or gateway): the config-object form.
  const config: OpenAICompatibleConfig = {
    id: EMBEDDING_MODEL_ID,
    url: url.replace(/\/$/, ''),
    ...(apiKey !== '' ? { apiKey } : {}),
  }
  return new ModelRouterEmbeddingModel(config)
}
