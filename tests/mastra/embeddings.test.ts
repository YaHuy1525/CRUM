import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('crumEmbeddingModel', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('exports EMBEDDING_MODEL_ID as openai/text-embedding-3-small', async () => {
    const { EMBEDDING_MODEL_ID } = await import('../../src/mastra/embeddings')
    expect(EMBEDDING_MODEL_ID).toBe('openai/text-embedding-3-small')
  })

  it('exports EMBEDDING_DIMENSIONS as 1536', async () => {
    const { EMBEDDING_DIMENSIONS } = await import('../../src/mastra/embeddings')
    expect(EMBEDDING_DIMENSIONS).toBe(1536)
  })

  it('returns a ModelRouterEmbeddingModel with no custom URL', async () => {
    vi.mock('../../src/config/env', () => ({
      parseEnv: () => ({
        EMBEDDING_BASE_URL: undefined,
        EMBEDDING_API_KEY: undefined,
        MODEL_API_KEY: undefined,
        NODE_ENV: 'test',
      }),
    }))
    const { crumEmbeddingModel } = await import('../../src/mastra/embeddings')
    const model = crumEmbeddingModel()
    expect(model).toBeDefined()
    expect(model.specificationVersion).toBe('v2')
  })

  it('returns a ModelRouterEmbeddingModel with custom URL', async () => {
    vi.mock('../../src/config/env', () => ({
      parseEnv: () => ({
        EMBEDDING_BASE_URL: 'https://embeddings.example.com/v1',
        EMBEDDING_API_KEY: 'test-key',
        NODE_ENV: 'test',
      }),
    }))
    const { crumEmbeddingModel } = await import('../../src/mastra/embeddings')
    const model = crumEmbeddingModel()
    expect(model).toBeDefined()
  })
})
