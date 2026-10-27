import { embedMany } from 'ai'
import { withRagIngestion } from '@mastra/core/observability'
import { MDocument } from '@mastra/rag'
import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { CRUM_CHUNK_PARAMS } from '../chunking'
import { crumEmbeddingModel, EMBEDDING_MODEL_ID } from '../embeddings'
import { tenantVectorStoreResolver, indexNameFor, CRUM_VECTOR_CONFIG } from '../vector-store'

const INGEST_BATCH = 32

export const parseStep = createStep({
  id: 'parse',
  inputSchema: z.object({
    documentId: z.string().uuid(),
    tenantId: z.string().uuid(),
    content: z.string(),
    contentType: z.enum(['text', 'markdown', 'html']),
    documentTitle: z.string(),
  }),
  outputSchema: z.object({
    documentId: z.string().uuid(),
    tenantId: z.string().uuid(),
    text: z.string(),
    contentType: z.string(),
    documentTitle: z.string(),
  }),
  execute: ({ inputData }) => {
    const text = inputData.content

    return Promise.resolve({
      documentId: inputData.documentId,
      tenantId: inputData.tenantId,
      text,
      contentType: inputData.contentType,
      documentTitle: inputData.documentTitle,
    })
  },
})

export const ingestStep = createStep({
  id: 'ingest',
  inputSchema: z.object({
    documentId: z.string().uuid(),
    tenantId: z.string().uuid(),
    text: z.string(),
    contentType: z.string(),
    documentTitle: z.string(),
  }),
  outputSchema: z.object({
    chunkCount: z.number(),
    indexName: z.string(),
  }),
  execute: async ({ inputData, mastra, requestContext, tracingContext }) => {
    const indexName = indexNameFor(inputData.tenantId)
    const embeddingModel = crumEmbeddingModel()

    return withRagIngestion(
      {
        mastra,
        name: 'crum knowledge ingest',
        tracingContext,
        requestContext,
        attributes: {
          vectorStore: 'pgvector',
          indexName,
          embeddingModel: EMBEDDING_MODEL_ID,
        },
      },
      async (observabilityContext) => {
        const doc = MDocument.fromText(inputData.text, {
          contentType: inputData.contentType,
        })
        const chunks = await doc.chunk(
          { ...CRUM_CHUNK_PARAMS, separators: [...CRUM_CHUNK_PARAMS.separators] },
          { observabilityContext },
        )

        const embeddings = await embedInBatches(
          chunks.map((c: { text: string }) => c.text),
          embeddingModel,
        )

        const pgVector = await tenantVectorStoreResolver({ requestContext, mastra })

        await pgVector.createIndex({ indexName, ...CRUM_VECTOR_CONFIG })

        await pgVector.upsert({
          indexName,
          vectors: embeddings,
          metadata: chunks.map(
            (c: { text: string; metadata?: { startIndex?: number } }, i: number) => ({
              text: c.text,
              sourceId: inputData.documentId,
              span: `${c.metadata?.startIndex ?? i}`,
              tenantId: inputData.tenantId,
              documentTitle: inputData.documentTitle,
              ingestedAt: new Date().toISOString(),
            }),
          ),
          ids: chunks.map(
            (c: { metadata?: { startIndex?: number } }, i: number) =>
              `${inputData.documentId}:${c.metadata?.startIndex ?? i}`,
          ),
        })

        return { chunkCount: chunks.length, indexName }
      },
    )
  },
})

async function embedInBatches(
  texts: string[],
  model: ReturnType<typeof crumEmbeddingModel>,
): Promise<number[][]> {
  const allEmbeddings: number[][] = []
  for (let i = 0; i < texts.length; i += INGEST_BATCH) {
    const batch = texts.slice(i, i + INGEST_BATCH)
    const { embeddings } = await embedMany({
      model,
      values: batch,
    })
    allEmbeddings.push(...embeddings)
  }
  return allEmbeddings
}

export const ingestWorkflow = createWorkflow({
  id: 'knowledge-ingest',
  inputSchema: z.object({
    documentId: z.string().uuid(),
    tenantId: z.string().uuid(),
    content: z.string(),
    contentType: z.enum(['text', 'markdown', 'html']),
    documentTitle: z.string(),
  }),
  outputSchema: z.object({
    chunkCount: z.number(),
    indexName: z.string(),
  }),
})
  .then(parseStep)
  .then(ingestStep)
  .commit()
