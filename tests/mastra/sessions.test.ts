import { describe, expect, it } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { parseEnv } from '../../src/config/env'
import type { CrumEnv } from '../../src/config/env'
import { createCrumMastra } from '../../src/mastra'
import {
  createSession,
  listSessions,
  queryThreads,
} from '../../src/mastra/sessions'

function envWith(overrides: Record<string, string> = {}): CrumEnv {
  return parseEnv({ NODE_ENV: 'development', ...overrides })
}

function testStore(): InMemoryStore {
  return new InMemoryStore({ id: 'sessions-test' })
}

describe('Agent Controller session wiring', () => {
  it('creates a session for crmAssistant', async () => {
    const env = envWith()
    const mastra = createCrumMastra(env, { storage: testStore() })

    const session = await createSession(mastra, {
      agentId: 'crm-assistant',
      resourceId: 'test-user-1',
    })

    expect(session).toBeDefined()
    // Session exposes thread and identity via accessor methods, not flat fields.
    expect(session.thread.getId()).toBeDefined()
    expect(session.identity.getResourceId()).toBe('test-user-1')
  })

  it('lists sessions for a resource via queryThreads-backed proxy', async () => {
    const env = envWith()
    const mastra = createCrumMastra(env, { storage: testStore() })

    // The controller groups threads by resourceId. Creating sessions under
    // distinct resourceIds produces distinct threads that listSessions returns.
    await createSession(mastra, {
      agentId: 'crm-assistant',
      resourceId: 'test-user-2a',
    })
    await createSession(mastra, {
      agentId: 'crm-assistant',
      resourceId: 'test-user-2b',
    })

    // listSessions returns sessions recovered from each thread.
    // We query for both resources individually to verify the sessions exist.
    const sessionsA = await listSessions(mastra, {
      agentId: 'crm-assistant',
      resourceId: 'test-user-2a',
    })
    const sessionsB = await listSessions(mastra, {
      agentId: 'crm-assistant',
      resourceId: 'test-user-2b',
    })

    expect(sessionsA.length).toBeGreaterThanOrEqual(1)
    expect(sessionsB.length).toBeGreaterThanOrEqual(1)
  })

  it('queryThreads returns threads without creating a session', async () => {
    const env = envWith()
    const mastra = createCrumMastra(env, { storage: testStore() })

    // No sessions created yet — threads should be empty.
    const empty = await queryThreads(mastra, {
      agentId: 'crm-assistant',
      resourceId: 'test-user-3',
    })
    expect(empty).toEqual([])

    // Create a session, then queryThreads should find its thread.
    await createSession(mastra, {
      agentId: 'crm-assistant',
      resourceId: 'test-user-3',
    })

    const threads = await queryThreads(mastra, {
      agentId: 'crm-assistant',
      resourceId: 'test-user-3',
    })
    expect(threads.length).toBeGreaterThanOrEqual(1)
    expect(threads[0]!.resourceId).toBe('test-user-3')
  })

  it('throws when the agent has no registered controller', async () => {
    const env = envWith()
    const mastra = createCrumMastra(env, { storage: testStore() })

    await expect(
      createSession(mastra, {
        agentId: 'nonexistent-agent',
        resourceId: 'test-user-4',
      }),
    ).rejects.toThrow(/no AgentController registered/)
  })
})
