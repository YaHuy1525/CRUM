// tests/mastra/workflows/ingest-asset-guard.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  getDocumentKind: vi.fn(),
  embedMany: vi.fn(),
  withRagIngestion: vi.fn(),
  fromText: vi.fn(),
  createIndex: vi.fn(),
  upsert: vi.fn(),
}))

vi.mock('../../../src/db/documents', () => ({ getDocumentKind: h.getDocumentKind }))
vi.mock('ai', () => ({ embedMany: h.embedMany }))
vi.mock('@mastra/core/observability', () => ({ withRagIngestion: h.withRagIngestion }))
vi.mock('@mastra/rag', () => ({ MDocument: { fromText: h.fromText } }))
vi.mock('../../../src/mastra/embeddings', () => ({
  crumEmbeddingModel: vi.fn(() => 'fake-embedding-model'),
  EMBEDDING_MODEL_ID: 'openai/text-embedding-3-small',
}))
vi.mock('../../../src/mastra/vector-store', () => ({
  // The real indexNameFor returns a constant, and the guard returns it unchanged
  // on the skipped path; mirroring the constant here is what lets the assertion
  // below be an equality rather than a typeof check.
  indexNameFor: () => 'crum_knowledge',
  CRUM_VECTOR_CONFIG: { dimension: 1536, metric: 'cosine' },
  tenantVectorStoreResolver: vi.fn(() => ({ createIndex: h.createIndex, upsert: h.upsert })),
}))

import { ingestStep, shouldSkipIngest } from '../../../src/mastra/workflows/ingest'

const TENANT = '11111111-1111-4111-8111-111111111111'
const DOC = '99999999-9999-4999-8999-999999999999'

// Only inputData is exercised; the execute-parameter union belongs to the
// framework contract, so the params are projected onto the real execute
// parameter type, which is the convention digest.mail.test.ts:40 already uses.
const params = {
  inputData: {
    documentId: DOC,
    tenantId: TENANT,
    text: 'a physio clinic reception at dawn',
    contentType: 'text',
    documentTitle: 'reception-hero.png',
  },
  requestContext: {},
  mastra: {},
  tracingContext: {},
} as unknown as Parameters<typeof ingestStep.execute>[0]

function run() {
  return ingestStep.execute(params) as Promise<{ chunkCount: number; indexName: string }>
}

beforeEach(() => {
  vi.clearAllMocks()
  // The observability helper is a pass-through: a test that reaches the
  // embedding path really does embed, so what is being pinned is whether the
  // guard lets the step get that far at all.
  h.withRagIngestion.mockImplementation(async (_meta: unknown, fn: (ctx: unknown) => Promise<unknown>) => fn({}))
  h.fromText.mockReturnValue({
    chunk: () => [{ text: 'a physio clinic reception at dawn', metadata: { startIndex: 0 } }],
  })
  h.createIndex.mockResolvedValue(undefined)
  h.upsert.mockResolvedValue(undefined)
  h.embedMany.mockResolvedValue({ embeddings: [[0.1, 0.2]] })
})

describe('shouldSkipIngest', () => {
  it('skips only a marketing asset', () => {
    expect(shouldSkipIngest('marketing_asset')).toBe(true)
    expect(shouldSkipIngest('invoice')).toBe(false)
    expect(shouldSkipIngest('contract')).toBe(false)
    expect(shouldSkipIngest('other')).toBe(false)
    expect(shouldSkipIngest(null)).toBe(false)
  })
})

describe('ingestStep', () => {
  it('never chunks, embeds, wraps or upserts a marketing asset', async () => {
    h.getDocumentKind.mockResolvedValue('marketing_asset')
    expect(await run()).toEqual({ chunkCount: 0, indexName: 'crum_knowledge' })
    expect(h.getDocumentKind).toHaveBeenCalledWith(TENANT, DOC)
    expect(h.withRagIngestion).not.toHaveBeenCalled()
    expect(h.fromText).not.toHaveBeenCalled()
    expect(h.embedMany).not.toHaveBeenCalled()
    expect(h.upsert).not.toHaveBeenCalled()
  })

  it('still indexes an invoice, because the guard is one kind and not a kill switch', async () => {
    h.getDocumentKind.mockResolvedValue('invoice')
    expect((await run()).chunkCount).toBe(1)
    expect(h.embedMany).toHaveBeenCalledTimes(1)
    expect(h.upsert).toHaveBeenCalledTimes(1)
  })

  it('indexes a document the read could not find rather than swallowing it', async () => {
    // null means "no such row for this tenant", which is a caller bug or a race
    // with a delete, not a generated asset. Falling through is the conservative
    // choice: an unexpectedly indexed document is visible in the index, a
    // silently un-indexed one is only visible when somebody fails to find it.
    h.getDocumentKind.mockResolvedValue(null)
    await run()
    expect(h.upsert).toHaveBeenCalledTimes(1)
  })

  it('reads the kind before it opens the ingestion span', async () => {
    const order: string[] = []
    h.getDocumentKind.mockImplementation(() => { order.push('kind'); return 'marketing_asset' })
    h.withRagIngestion.mockImplementation(() => { order.push('span'); return { chunkCount: 0, indexName: 'crum_knowledge' } })
    await run()
    expect(order).toEqual(['kind'])
  })
})
