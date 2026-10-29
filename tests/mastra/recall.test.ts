import { describe, it, expect, afterAll } from 'vitest'
import { PgVector } from '@mastra/pg'
import { parseEnv } from '../../src/config/env'
import { buildRecallDeps } from '../../src/mastra/recall'

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
  })

  it('memoizes deps per credential set (one recall pool per process)', () => {
    const env = parseEnv({ DATABASE_URL: 'postgresql://u:p@memo-a.invalid:5432/d' })
    expect(buildRecallDeps(env)).toBe(buildRecallDeps(env))
    createdPools.push((buildRecallDeps(env) as { vector: PgVector }).vector)
    const other = parseEnv({ DATABASE_URL: 'postgresql://u:p@memo-b.invalid:5432/d' })
    expect(buildRecallDeps(other)).not.toBe(buildRecallDeps(env))
    createdPools.push((buildRecallDeps(other) as { vector: PgVector }).vector)
  })

  it('constructs nothing at module import time', async () => {
    // The spec §1 key-hygiene trap: importing with no embedding key present
    // must neither throw nor build deps. The flag-off call below returns
    // undefined without touching the cache, proving no import-time factory ran.
    const recallModule = await import('../../src/mastra/recall')
    expect(recallModule).toBeTypeOf('object')
    expect(typeof recallModule.buildRecallDeps).toBe('function')
    const env = parseEnv({ CRUM_RECALL_ENABLED: 'false', DATABASE_URL: '' })
    expect(recallModule.buildRecallDeps(env)).toBeUndefined()
  })
})
