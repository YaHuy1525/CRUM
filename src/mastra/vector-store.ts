// src/mastra/vector-store.ts
import { PgVector } from '@mastra/pg'
import type { VectorStoreResolver } from '@mastra/rag'
import { EMBEDDING_DIMENSIONS } from './embeddings'

/**
 * Schema-per-tenant vector store resolver. §6.3.4.
 *
 * CRUM isolates knowledge per tenant with a schema-per-tenant VectorStoreResolver,
 * not with a metadata filter. The resolver receives { requestContext, mastra }
 * and is evaluated per execution, so the tenant comes from the trusted request
 * context set by middleware, never from the model or the client body.
 */
const storeCache = new Map<string, PgVector>()

export const tenantVectorStoreResolver: VectorStoreResolver = ({ requestContext }) => {
  // RequestContext.get() returns `unknown`-ish `{}` in the shipped types, so the
  // tenant id is narrowed for real rather than asserted into existence.
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

/**
 * All tenants share one index name. The schema boundary is the isolation,
 * not the index name. §6.3.4.
 */
export function indexNameFor(_tenantId: string): string {
  return 'crum_knowledge'
}

/**
 * PgVector index configuration for tenant schemas. Passed to createIndex()
 * during ingest to set dimension, distance metric, HNSW parameters, and
 * metadata btree indexes. Kept here so all vector-store config lives in one module.
 *
 * Note: These are createIndex() parameters, not PgVector constructor parameters.
 * The PgVector constructor only accepts connection config (connectionString, schemaName, id).
 */
export const CRUM_VECTOR_CONFIG = {
  dimension: EMBEDDING_DIMENSIONS,
  metric: 'cosine' as const,
  indexConfig: { type: 'hnsw' as const, hnsw: { m: 16, efConstruction: 64 } },
  metadataIndexes: ['sourceId', 'documentTitle'],
}
