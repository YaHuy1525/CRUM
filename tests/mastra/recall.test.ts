import { describe, it, expect, afterAll, vi } from 'vitest'
import { PgVector } from '@mastra/pg'
import { parseEnv } from '../../src/config/env'
import { buildRecallDeps, resolveEmbeddingDimension } from '../../src/mastra/recall'

describe('buildRecallDeps', () => {
  // PgVector's constructor opens a real (idle, never-connecting here) pg.Pool
  // eagerly; close the ones these tests created so no handle outlives the file.
  const createdPools: PgVector[] = []
  afterAll(async () => {
    await Promise.all(createdPools.map((v) => v.pool.end()))
  })

  it('returns undefined when recall is off', () => {
    const env = parseEnv({ CRUM_RECALL_ENABLED: 'false', DATABASE_URL: 'postgresql://u:p@h:5432/d' })
    expect(buildRecallDeps(env)).toBeUndefined()
  })

  it('returns undefined with no database url (in-memory CI)', () => {
    // Explicit empty DATABASE_URL: must not depend on the runner's process.env.
    const env = parseEnv({ DATABASE_URL: '' })
    expect(buildRecallDeps(env)).toBeUndefined()
  })

  it('builds vector + embedder deps when recall is on with a database', () => {
    // Hosts that do not resolve: construction alone makes no network call —
    // PgVector takes a connection string and the embedder is a config object.
    const env = parseEnv({ DATABASE_URL: 'postgresql://u:p@recall-a.invalid:5432/d' })
    const deps = buildRecallDeps(env)
    createdPools.push(deps!.vector)
    expect(deps).toBeDefined()
    expect(deps!.vector).toBeInstanceOf(PgVector)
    expect(deps!.embedder).toBeDefined()
    // The dimension must ride along: 1536 is what the CRUM default model returns,
    // and declaring it is what keeps the embedding endpoint off the turn-critical
    // path (RecallDeps.embeddingDimension).
    expect(deps!.embeddingDimension).toBe(1536)
  })

  it('memoizes deps per credential set (one recall pool per process)', () => {
    const env = parseEnv({ DATABASE_URL: 'postgresql://u:p@memo-a.invalid:5432/d' })
    expect(buildRecallDeps(env)).toBe(buildRecallDeps(env))
    createdPools.push((buildRecallDeps(env) as { vector: PgVector }).vector)
    const other = parseEnv({ DATABASE_URL: 'postgresql://u:p@memo-b.invalid:5432/d' })
    expect(buildRecallDeps(other)).not.toBe(buildRecallDeps(env))
    createdPools.push((buildRecallDeps(other) as { vector: PgVector }).vector)
  })

  it('exposes the factory without constructing anything at module import', async () => {
    // The spec §1 key-hygiene trap: importing the module with no embedding key
    // present must not throw. This checks the import is side-effect-free at the
    // module top level (no pool/embedder built during evaluation) and that the
    // flag-off path returns undefined; it does NOT introspect the private cache.
    const recallModule = await import('../../src/mastra/recall')
    expect(recallModule).toBeTypeOf('object')
    expect(typeof recallModule.buildRecallDeps).toBe('function')
    const env = parseEnv({ CRUM_RECALL_ENABLED: 'false', DATABASE_URL: '' })
    expect(recallModule.buildRecallDeps(env)).toBeUndefined()
  })

  it('warns when EMBEDDING_DIMENSIONS disagrees with a known model', () => {
    // A declared dimension that the embedder does not return is NOT fail-soft:
    // SemanticRecall rethrows the mismatch and aborts the turn, so the curated
    // table wins. The override has to be visible, not silently dropped.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const env = parseEnv({
        DATABASE_URL: 'postgresql://u:p@recall-dim.invalid:5432/d',
        MASTRA_MEMORY_EMBEDDER: 'openai/text-embedding-3-large',
        EMBEDDING_DIMENSIONS: '999',
      })
      const deps = buildRecallDeps(env)
      createdPools.push(deps!.vector)
      expect(deps!.embeddingDimension).toBe(3072)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('EMBEDDING_DIMENSIONS=999 ignored'))
    } finally {
      warn.mockRestore()
    }
  })
})

describe('resolveEmbeddingDimension', () => {
  it('reads the dimension off Mastra’s curated table for a known model', () => {
    // Model ids arrive provider-stripped (ModelRouterEmbeddingModel normalises
    // both constructor shapes), which is how the table is keyed.
    expect(resolveEmbeddingDimension('text-embedding-3-small')).toBe(1536)
    expect(resolveEmbeddingDimension('text-embedding-3-large')).toBe(3072)
    expect(resolveEmbeddingDimension('gemini-embedding-001')).toBe(768)
  })

  it('falls back to the operator value for a model the table does not list', () => {
    expect(resolveEmbeddingDimension('my-local-bge-m3', 1024)).toBe(1024)
  })

  it('declares nothing for an unknown model rather than guessing', () => {
    // undefined restores Mastra's probe. Guessing 1536 for an embedder that
    // returns another width would trade the probe failure for the mismatch
    // failure, which is the bug being hardened.
    expect(resolveEmbeddingDimension('my-local-bge-m3')).toBeUndefined()
  })

  it('lets the table win over a disagreeing operator value for a known model', () => {
    expect(resolveEmbeddingDimension('text-embedding-3-small', 3072)).toBe(1536)
  })
})
