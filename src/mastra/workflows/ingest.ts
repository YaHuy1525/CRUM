import { embedMany } from 'ai'
import { withRagIngestion } from '@mastra/core/observability'
import { MDocument } from '@mastra/rag'
import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { CRUM_CHUNK_PARAMS } from '../chunking'
import { crumEmbeddingModel, EMBEDDING_MODEL_ID } from '../embeddings'
import { tenantVectorStoreResolver, indexNameFor, CRUM_VECTOR_CONFIG } from '../vector-store'

const INGEST_BATCH = 32

/**
 * Parse step: bytes → text or markdown. §6.3.2.
 *
 * MDocument has four factories: fromText, fromHTML, fromMarkdown, fromJSON.
 * There is no fromPdf and no fromDocx. PDF and DOCX are converted to text or
 * markdown before Mastra sees them (unpdf for PDF, mammoth for DOCX). This step
 * owns that conversion.
 *
 * Parsing stays a separate step because it is CPU-bound, worth retrying on its
 * own, and its output is plain text that serialises cleanly.
 */
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
    // For Phase 4, content arrives pre-parsed (text/markdown/html).
    // PDF and DOCX conversion (unpdf/mammoth) is a follow-up when the upload
    // API handles binary files. The step boundary is correct either way.
    const text = inputData.content

    // The Mastra ExecuteFunction contract wants a Promise; this step does no IO,
    // so it resolves one rather than being declared async.
    return Promise.resolve({
      documentId: inputData.documentId,
      tenantId: inputData.tenantId,
      text,
      contentType: inputData.contentType,
      documentTitle: inputData.documentTitle,
    })
  },
})

/**
 * Ingest step: chunk + embed + upsert, inside one withRagIngestion scope. §6.3.2.
 *
 * Mastra instruments ingestion through an ObservabilityContext threaded into
 * doc.chunk(), embedMany() and vectorStore.upsert(). That context cannot travel
 * through a workflow step output, because step data is schema-validated and
 * persisted. Splitting chunk, embed and upsert across three steps would either
 * drop the context or produce three unrelated span trees.
 */
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
        // CRUM_CHUNK_PARAMS is `as const`, so its separators tuple is readonly;
        // RecursiveChunkOptions wants a mutable string[]. Copy instead of widening
        // the shared constant, which other call sites rely on.
        const chunks = await doc.chunk(
          { ...CRUM_CHUNK_PARAMS, separators: [...CRUM_CHUNK_PARAMS.separators] },
          { observabilityContext },
        )

        const embeddings = await embedInBatches(
          chunks.map((c: { text: string }) => c.text),
          embeddingModel,
        )

        const pgVector = await tenantVectorStoreResolver({ requestContext, mastra })

        // Ensure the index exists with the correct dimension, metric, and HNSW config.
        // createIndex is idempotent — it skips creation if the index already exists.
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

/**
 * Embed in batches of INGEST_BATCH. embedMany from ai handles the batching
 * internally when given an array, but we chunk explicitly to stay under
 * provider rate limits. §6.3.2.
 */
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

/**
 * The complete ingest workflow: parse → ingest. §6.3.2.
 */
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
