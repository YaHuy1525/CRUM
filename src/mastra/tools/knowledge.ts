import { createVectorQueryTool } from '@mastra/rag'
import { ModelRouterEmbeddingModel } from '@mastra/core/llm'
import { tenantVectorStoreResolver } from '../vector-store'
import { EMBEDDING_MODEL_ID } from '../embeddings'

/**
 * Knowledge retrieval via vector search with reranking. §6.3.3.
 *
 * Corrections against v0.2:
 * - createVectorQueryTool comes from @mastra/rag, not @mastra/core/tools.
 * - reranker.options.weights must sum to 1. CRUM shifts toward semantic because
 *   contract language is paraphrased more often than quoted.
 * - The reranker needs metadata.text. Ingestion writes it for that reason.
 * - PgVector returns an empty document field. Chunk text is read from
 *   sources[i].metadata.text.
 */
export const knowledgeRetrieveTool = createVectorQueryTool({
  id: 'knowledge.retrieve',
  description:
    'Search uploaded contracts, proposals, playbooks and call transcripts for the current tenant. ' +
    'Returns chunk text with sourceId and span for citation. Use it for prose questions; never for ' +
    'customer, deal or task records, which have their own tools.',
  vectorStore: tenantVectorStoreResolver,
  indexName: 'crum_knowledge',
  model: new ModelRouterEmbeddingModel(EMBEDDING_MODEL_ID),
  enableFilter: true,
  includeSources: true,
  databaseConfig: {
    pgvector: {
      minScore: 0.35,
      ef: 128,
      probes: 12,
    },
  },
  reranker: {
    model: new ModelRouterEmbeddingModel(EMBEDDING_MODEL_ID),
    options: {
      weights: { semantic: 0.5, vector: 0.3, position: 0.2 },
      topK: 5,
    },
  },
})
