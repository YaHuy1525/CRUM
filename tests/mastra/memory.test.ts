import { describe, it, expect } from 'vitest'
import { Memory } from '@mastra/memory'
import { buildCrumMemory } from '../../src/mastra/memory'
import { buildMastraStorage } from '../../src/mastra/storage'
import { parseEnv } from '../../src/config/env'

describe('buildCrumMemory', () => {
  it('returns a Memory instance', () => {
    const env = parseEnv()
    const storage = buildMastraStorage(env)
    const memory = buildCrumMemory(storage)
    expect(memory).toBeInstanceOf(Memory)
  })

  it('configures messageHistory.maxTokens to 24_000', () => {
    const env = parseEnv()
    const storage = buildMastraStorage(env)
    const memory = buildCrumMemory(storage)

    // Access the merged config to verify messageHistory settings
    // getMergedThreadConfig() returns the instance's configured values
    const config = memory.getMergedThreadConfig()
    expect(config.messageHistory?.maxTokens).toBe(24_000)
  })

  it('does NOT configure lastMessages (uses messageHistory instead)', () => {
    const env = parseEnv()
    const storage = buildMastraStorage(env)
    const memory = buildCrumMemory(storage)

    // Verify the config uses messageHistory, not lastMessages
    const config = memory.getMergedThreadConfig()
    expect(config.messageHistory).toBeDefined()
    expect(config.lastMessages).toBeUndefined()
  })
})
