import { describe, it, expect } from 'vitest'
import { Memory } from '@mastra/memory'
import { buildCrumMemory } from '../../src/mastra/memory'
import { buildMastraStorage } from '../../src/mastra/storage'
import { parseEnv } from '../../src/config/env'
import { CRUM_LIGHT_MODEL } from '../../src/mastra/models'
import type { RecallDeps } from '../../src/mastra/recall'

// A minimal stand-in for the lazily-built recall deps: buildCrumMemory only
// passes these through to the Memory constructor, it never calls into them. The
// constructor validates that a configured semanticRecall has a truthy vector and
// an embedder (agent-tuAMgHe3.js:21702-21711), so the stub carries both.
const stubRecall = {
  vector: { isSelfEmbedding: false },
  embedder: () => ({ embedding: [] }),
} as unknown as RecallDeps

describe('buildCrumMemory', () => {
  it('returns a Memory instance', () => {
    const env = parseEnv({ CRUM_OM_ENABLED: 'false' })
    const storage = buildMastraStorage(env)
    const memory = buildCrumMemory(storage, env)
    expect(memory).toBeInstanceOf(Memory)
  })

  it('configures messageHistory.maxTokens to 24_000', () => {
    const env = parseEnv({ CRUM_OM_ENABLED: 'false' })
    const storage = buildMastraStorage(env)
    const memory = buildCrumMemory(storage, env)

    // Access the merged config to verify messageHistory settings
    // getMergedThreadConfig() returns the instance's configured values
    const config = memory.getMergedThreadConfig()
    expect(config.messageHistory?.maxTokens).toBe(24_000)
  })

  it('does NOT configure lastMessages (uses messageHistory instead)', () => {
    const env = parseEnv({ CRUM_OM_ENABLED: 'false' })
    const storage = buildMastraStorage(env)
    const memory = buildCrumMemory(storage, env)

    // Verify the config uses messageHistory, not lastMessages
    const config = memory.getMergedThreadConfig()
    expect(config.messageHistory).toBeDefined()
    expect(config.lastMessages).toBeUndefined()
  })

  it('leaves options unchanged when the kill-switch is off', () => {
    const env = parseEnv({ CRUM_OM_ENABLED: 'false' })
    const memory = buildCrumMemory(buildMastraStorage(env), env)
    const config = memory.getMergedThreadConfig()
    expect(config.observationalMemory).toBeUndefined()
    expect(config.messageHistory?.maxTokens).toBe(24_000)
  })

  it('enables observational memory on the light model by default', () => {
    const env = parseEnv({})
    const memory = buildCrumMemory(buildMastraStorage(env), env)
    const config = memory.getMergedThreadConfig()
    expect(config.observationalMemory).toBeTruthy()
  })

  it('omits semantic recall when deps are absent', () => {
    const env = parseEnv({ CRUM_RECALL_ENABLED: 'false' })
    const memory = buildCrumMemory(buildMastraStorage(env), env)
    // The pinned Memory normalizes an unconfigured semanticRecall to `false`
    // (getMergedThreadConfig), not `undefined` — assert falsy, not undefined.
    expect(memory.getMergedThreadConfig().semanticRecall).toBeFalsy()
  })

  it('leaves options unchanged when the recall kill-switch is off even with deps', () => {
    // The kill-switch is authoritative: passing deps must not resurrect recall
    // when the flag is off, so the object stays byte-identical to the base.
    const env = parseEnv({ CRUM_OM_ENABLED: 'false', CRUM_RECALL_ENABLED: 'false' })
    const memory = buildCrumMemory(buildMastraStorage(env), env, stubRecall)
    expect(memory.getMergedThreadConfig().semanticRecall).toBeFalsy()
    // Byte-identity is a constructor-level claim, not just options: the flag-off
    // branch must omit vector+embedder entirely, so no unused store is attached.
    expect(memory.vector).toBeUndefined()
    expect(memory.embedder).toBeUndefined()
  })

  it('adds resource-scoped semantic recall when deps are present', () => {
    const env = parseEnv({ CRUM_RECALL_ENABLED: 'true' })
    const memory = buildCrumMemory(buildMastraStorage(env), env, stubRecall)
    const config = memory.getMergedThreadConfig()
    expect(config.semanticRecall).toMatchObject({
      topK: 4,
      messageRange: 2,
      scope: 'resource',
      // HNSW must be set explicitly or PgVector silently builds ivfflat (doc §5).
      indexConfig: { type: 'hnsw', metric: 'cosine', hnsw: { m: 16, efConstruction: 64 } },
    })
    // No static tenant predicate: the value varies per caller (doc §4/§5).
    expect((config.semanticRecall as { filter?: unknown }).filter).toBeUndefined()
  })

  it('configures server-side title generation on a model', () => {
    const env = parseEnv({ CRUM_OM_ENABLED: 'false' })
    const memory = buildCrumMemory(buildMastraStorage(env), env)
    const config = memory.getMergedThreadConfig()
    // memoryDefaultOptions.generateTitle is `false`; buildCrumMemory must flip it
    // to an object. Pin the model identity (this file's convention: the recall
    // test pins concrete values) so an accidental switch off the light model fails.
    expect(config.generateTitle).toMatchObject({ model: CRUM_LIGHT_MODEL })
  })
})
