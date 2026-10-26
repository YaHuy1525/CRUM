import { createVectorQueryTool } from '@mastra/rag'
import { ModelRouterLanguageModel } from '@mastra/core/llm'
import { crumEmbeddingModel } from '../embeddings'
import { CRUM_LIGHT_MODEL } from '../models'
import { tenantVectorStoreResolver } from '../vector-store'

export const knowledgeRetrieveTool = createVectorQueryTool({
  id: 'knowledge.retrieve',
  description:
    'Search uploaded contracts, proposals, playbooks and call transcripts for the current tenant. ' +
    'Returns chunk text with sourceId and span for citation. Use it for prose questions; never for ' +
    'customer, deal or task records, which have their own tools.',
  vectorStore: tenantVectorStoreResolver,
  indexName: 'crum_knowledge',
  model: crumEmbeddingModel(),
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
    model: new ModelRouterLanguageModel(CRUM_LIGHT_MODEL),
    options: {
      weights: { semantic: 0.5, vector: 0.3, position: 0.2 },
      topK: 5,
    },
  },
})
