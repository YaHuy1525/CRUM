import { describe, it, expect, vi } from 'vitest'
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

  it('omits observationalMemory when the OM kill-switch is off', () => {
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

  it('omits semantic recall when the flag is off and deps are absent', () => {
    const env = parseEnv({ CRUM_RECALL_ENABLED: 'false' })
    const memory = buildCrumMemory(buildMastraStorage(env), env)
    // The pinned Memory normalizes an unconfigured semanticRecall to `false`
    // (getMergedThreadConfig), not `undefined` — assert falsy, not undefined.
    expect(memory.getMergedThreadConfig().semanticRecall).toBeFalsy()
  })

  it('omits recall keys when the recall kill-switch is off even with deps', () => {
    // The kill-switch is authoritative: passing deps must not resurrect recall
    // when the flag is off, so no recall addition leaks in.
    const env = parseEnv({ CRUM_OM_ENABLED: 'false', CRUM_RECALL_ENABLED: 'false' })
    const memory = buildCrumMemory(buildMastraStorage(env), env, stubRecall)
    expect(memory.getMergedThreadConfig().semanticRecall).toBeFalsy()
    // No-store-attached is a constructor-level claim, not just options: the
    // flag-off branch must omit vector+embedder entirely.
    expect(memory.vector).toBeUndefined()
    expect(memory.embedder).toBeUndefined()
  })

  it('builds OM-on/recall-off without a vector lane (search route answers 503)', () => {
    // The two switches stay independent (spec §7). This combination is the
    // degraded one research doc §4 names: observationalMemory is configured
    // but no vector store exists, so searchMessages would throw — the GET
    // /api/agent/search route guards it with 503 search-unavailable
    // (tests/api/threads.test.ts pins the route half).
    const env = parseEnv({ CRUM_OM_ENABLED: 'true', CRUM_RECALL_ENABLED: 'false' })
    const memory = buildCrumMemory(buildMastraStorage(env), env)
    expect(memory.getMergedThreadConfig().observationalMemory).toBeTruthy()
    expect(memory.vector).toBeUndefined()
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

  it('builds the recall processor without touching the embedder once the dimension is declared', async () => {
    // Regression for the 2026-10-30 outage. Both processor builders call
    // getEmbeddingDimension() on EVERY turn (agent-tuAMgHe3.js:22015, :22114), and
    // a probe failure throws MASTRA_MEMORY_GET_EMBEDDING_DIMENSION_FAILED from the
    // builder itself — outside SemanticRecall's own try/catch (:23061-23077,
    // :23344-23348), so one unreachable embedding endpoint aborted all chat.
    // A declared dimension short-circuits the probe (:21778); embedding failures
    // then only happen inside the processor, where they degrade to no recall.
    const probe = vi.fn(() =>
      Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:20128')),
    )
    const env = parseEnv({ CRUM_OM_ENABLED: 'false', CRUM_RECALL_ENABLED: 'true' })
    const memory = buildCrumMemory(buildMastraStorage(env), env, {
      vector: { isSelfEmbedding: false },
      embedder: { modelId: 'text-embedding-3-small', doEmbed: probe },
      embeddingDimension: 1536,
    } as unknown as RecallDeps)

    // `embeddingDimension` is protected on MastraMemory, so the contract is proven
    // through the probe, which is the behaviour that actually matters.
    await expect(memory.getInputProcessors()).resolves.toContainEqual(
      expect.objectContaining({ id: 'semantic-recall' }),
    )
    expect(probe).not.toHaveBeenCalled()
  })

  it('probes the embedder, and fails the turn, when no dimension is declared', async () => {
    // Pins the causal link the test above hardens against: with no
    // embeddingDimension the builder reaches the network, and an unreachable
    // endpoint rejects before any processor runs. This is why buildRecallDeps must
    // not leave the field undefined for a model it can resolve.
    const probe = vi.fn(() => Promise.reject(new Error('embedder unreachable')))
    const env = parseEnv({ CRUM_OM_ENABLED: 'false', CRUM_RECALL_ENABLED: 'true' })
    const memory = buildCrumMemory(buildMastraStorage(env), env, {
      vector: { isSelfEmbedding: false },
      embedder: { modelId: 'text-embedding-3-small', doEmbed: probe },
    } as unknown as RecallDeps)

    await expect(memory.getInputProcessors()).rejects.toThrow()
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
