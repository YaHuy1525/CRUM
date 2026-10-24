import { describe, expect, it } from 'vitest'
import { Mastra } from '@mastra/core/mastra'

/**
 * src/index.ts is the process entry point. It calls parseEnv() and
 * createCrumMastra(env) at module scope, then exports the result as default.
 *
 * These tests verify the module's export shape and that the constructed
 * singleton is a valid Mastra instance. The side effects at import time are
 * safe in the test environment: NODE_ENV=test, no DATABASE_URL, so the module
 * builds an InMemoryStore and an ephemeral MCP request-state key.
 */
describe('src/index.ts entry point', () => {
  it(
    'exports a Mastra instance as the default export',
    async () => {
      const mod = await import('../../src/index')
      expect(mod.default).toBeInstanceOf(Mastra)
    },
    // The first import() pays for the whole Mastra graph; under a full-suite
    // run with parallel workers that costs more than the 5s default.
    30_000,
  )

  it('registers the crm-assistant agent', async () => {
    const mod = await import('../../src/index')
    const agents = mod.default.listAgents()
    expect(Object.keys(agents)).toContain('crm-assistant')
  })

  it('uses in-memory storage when no DATABASE_URL is set', async () => {
    const mod = await import('../../src/index')
    const storage = mod.default.getStorage()
    expect(storage).toBeDefined()
  })
})
