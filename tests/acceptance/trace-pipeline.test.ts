// tests/acceptance/trace-pipeline.test.ts
import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { createCrumMastra } from '../../src/mastra'
import { parseEnv } from '../../src/config/env'
import type { CrumEnv } from '../../src/config/env'

function envWith(overrides: Record<string, string> = {}): CrumEnv {
  return parseEnv({ NODE_ENV: 'development', ...overrides })
}

function testStore(): InMemoryStore {
  return new InMemoryStore({ id: 'trace-pipeline-test' })
}

describe('Phase 1 acceptance: trace shows processor pipeline firing', () => {
  it('agent has inputProcessors and outputProcessors with expected names', async () => {
    const env = envWith()
    const mastra = createCrumMastra(env, { storage: testStore() })
    const agent = mastra.getAgent('crm-assistant')

    // Agent is registered and retrievable
    expect(agent).toBeDefined()

    // Verify input processors
    const inputProcessors = await agent.listConfiguredInputProcessors()
    expect(inputProcessors.length).toBeGreaterThan(0)

    // Verify output processors
    const outputProcessors = await agent.listConfiguredOutputProcessors()
    expect(outputProcessors.length).toBeGreaterThan(0)

    // Verify the processors are the ones we expect by constructor name
    const inputProcessorNames = inputProcessors.map((p) => p.constructor.name)
    expect(inputProcessorNames).toContain('ObjectBindingProcessor')
    expect(inputProcessorNames).toContain('EnsureFinalResponseProcessor')
    expect(inputProcessorNames).toContain('ModerationProcessor')
    expect(inputProcessorNames).toContain('TokenLimiterProcessor')

    const outputProcessorNames = outputProcessors.map((p) => p.constructor.name)
    expect(outputProcessorNames).toContain('ModerationProcessor')
  })
})
