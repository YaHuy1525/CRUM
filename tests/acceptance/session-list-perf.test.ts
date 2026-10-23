// tests/acceptance/session-list-perf.test.ts
import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { createCrumMastra } from '../../src/mastra'
import { createSession, queryThreads } from '../../src/mastra/sessions'
import { parseEnv } from '../../src/config/env'
import type { CrumEnv } from '../../src/config/env'

function envWith(overrides: Record<string, string> = {}): CrumEnv {
  return parseEnv({ NODE_ENV: 'development', ...overrides })
}

function testStore(): InMemoryStore {
  return new InMemoryStore({ id: 'session-list-perf-test' })
}

describe('Phase 1 acceptance: session list renders under 300ms', () => {
  it('queryThreads completes in under 300ms for a resource with 10 sessions', async () => {
    const env = envWith()
    const mastra = createCrumMastra(env, { storage: testStore() })

    // Create 10 sessions with distinct threadIds so the controller provisions 10 threads
    // under the same resourceId.
    const resourceId = 'perf-test-user'
    for (let i = 0; i < 10; i++) {
      await createSession(mastra, {
        agentId: 'crm-assistant',
        resourceId,
        threadId: `perf-thread-${i}`,
      })
    }

    // Measure queryThreads latency
    const start = performance.now()
    const threads = await queryThreads(mastra, {
      agentId: 'crm-assistant',
      resourceId,
    })
    const elapsed = performance.now() - start

    expect(threads.length).toBeGreaterThanOrEqual(10)
    expect(elapsed).toBeLessThan(300)

    // eslint-disable-next-line no-console
    console.log(`queryThreads latency: ${elapsed.toFixed(2)}ms`)
  })
})
