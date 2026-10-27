// tests/mastra/vector-store.test.ts
import { describe, it, expect } from 'vitest'
import { CRUM_CHUNK_PARAMS } from '../../src/mastra/chunking'
import { indexNameFor, tenantVectorStoreResolver } from '../../src/mastra/vector-store'

describe('CRUM_CHUNK_PARAMS', () => {
  it('uses recursive strategy with maxSize 900 and overlap 120', () => {
    expect(CRUM_CHUNK_PARAMS.strategy).toBe('recursive')
    expect(CRUM_CHUNK_PARAMS.maxSize).toBe(900)
    expect(CRUM_CHUNK_PARAMS.overlap).toBe(120)
  })

  it('includes separatorPosition end and addStartIndex true', () => {
    expect(CRUM_CHUNK_PARAMS.separatorPosition).toBe('end')
    expect(CRUM_CHUNK_PARAMS.addStartIndex).toBe(true)
  })
})

describe('indexNameFor', () => {
  it('returns crum_knowledge for any tenant', () => {
    expect(indexNameFor('tenant-abc')).toBe('crum_knowledge')
  })
})

describe('tenantVectorStoreResolver', () => {
  it('is a function', () => {
    expect(typeof tenantVectorStoreResolver).toBe('function')
  })
})
