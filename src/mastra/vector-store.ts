import { PgVector } from '@mastra/pg'
import type { VectorStoreResolver } from '@mastra/rag'
import { EMBEDDING_DIMENSIONS } from './embeddings'

const storeCache = new Map<string, PgVector>()

export const tenantVectorStoreResolver: VectorStoreResolver = ({ requestContext }) => {
  const rawTenantId = requestContext?.get('tenantId')
  if (typeof rawTenantId !== 'string' || rawTenantId === '') {
    throw new Error('tenantId is required in request context')
  }
  const tenantId = rawTenantId

  if (!storeCache.has(tenantId)) {
    storeCache.set(
      tenantId,
      new PgVector({
        id: `pg-vector-${tenantId}`,
        connectionString: process.env.DATABASE_URL!,
        schemaName: `tenant_${tenantId}`,
      }),
    )
  }
  return storeCache.get(tenantId)!
}

export function indexNameFor(_tenantId: string): string {
  return 'crum_knowledge'
}

export const CRUM_VECTOR_CONFIG = {
  dimension: EMBEDDING_DIMENSIONS,
  metric: 'cosine' as const,
  indexConfig: { type: 'hnsw' as const, hnsw: { m: 16, efConstruction: 64 } },
  metadataIndexes: ['sourceId', 'documentTitle'],
}
