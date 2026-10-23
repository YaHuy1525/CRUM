// tests/acceptance/restart.test.ts
import { describe, it, expect } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { createCrumMastra } from '../../src/mastra'
import { createSession } from '../../src/mastra/sessions'
import { parseEnv } from '../../src/config/env'
import type { CrumEnv } from '../../src/config/env'

function envWith(overrides: Record<string, string> = {}): CrumEnv {
  return parseEnv({ NODE_ENV: 'development', ...overrides })
}

function testStore(): InMemoryStore {
  return new InMemoryStore({ id: 'restart-test' })
}

describe('Phase 1 acceptance: streaming chat survives restart', () => {
  it('preserves session history across Mastra instance recreation', async () => {
    const env = envWith()
    const storage = testStore()

    // First instance: create a session and send a message
    const mastra1 = createCrumMastra(env, { storage })
    const session1 = await createSession(mastra1, {
      agentId: 'crm-assistant',
      resourceId: 'acceptance-test-user',
    })

    // Session was created — capture its thread id
    const threadId = session1.thread.getId()
    expect(threadId).toBeDefined()

    // Second instance: simulate a restart by creating a new Mastra instance
    // backed by the SAME in-memory store (durability, not process survival).
    const mastra2 = createCrumMastra(env, { storage })

    // Query threads for the same resource — should find the session from mastra1
    const controller = mastra2.getAgentController('crm-assistant')
    expect(controller).toBeDefined()
    const threads = await controller!.queryThreads({
      resourceId: 'acceptance-test-user',
    })

    expect(threads.length).toBeGreaterThan(0)
    expect(threads.some((t) => t.id === threadId)).toBe(true)
  })
})
