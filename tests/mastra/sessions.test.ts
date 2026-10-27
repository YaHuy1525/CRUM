import { describe, expect, it } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { parseEnv } from '../../src/config/env'
import type { CrumEnv } from '../../src/config/env'
import { createCrumMastra } from '../../src/mastra'
import {
  createSession,
  listSessions,
  queryThreads,
  resolveSession,
  resourceIdFor,
} from '../../src/mastra/sessions'

function envWith(overrides: Record<string, string> = {}): CrumEnv {
  return parseEnv({ NODE_ENV: 'development', ...overrides })
}

function testStore(): InMemoryStore {
  return new InMemoryStore({ id: 'sessions-test' })
}

/** Same env for every case here; named so the new suite reads as one intent. */
function repoEnv(): CrumEnv {
  return parseEnv({ NODE_ENV: 'development' })
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
    const env = repoEnv()
    const mastra = createCrumMastra(env, { storage: testStore() })

    await expect(
      createSession(mastra, {
        agentId: 'nonexistent-agent',
        resourceId: 'test-user-4',
      }),
    ).rejects.toThrow(/no AgentController registered/)
  })
})

/**
 * `resolveSession` was a `throw` with a TODO, so `/api/signals/*` answered 500
 * on every request. These run against a real AgentController and an
 * `InMemoryStore` — no mocks, because the ownership rules being enforced live
 * inside the controller's own recovery path, and a stubbed controller would
 * prove nothing about them.
 */
describe('resolveSession', () => {
  const TENANT = '550e8400-e29b-41d4-a716-446655440000'
  const OTHER = '660e8400-e29b-41d4-a716-446655440009'
  const resourceA = `${TENANT}:user-a`
  const resourceB = `${TENANT}:user-b`

  it('returns the live session for its own resource', async () => {
    const mastra = createCrumMastra(repoEnv(), { storage: testStore() })
    const created = await createSession(mastra, { agentId: 'crm-assistant', resourceId: resourceA, id: 'session-live' })

    const resolved = await resolveSession(mastra, {
      sessionId: 'session-live',
      tenantId: TENANT,
      resourceId: resourceA,
    })

    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    // The same object, not a reconstruction: a new session could not steer the
    // run the old one is holding.
    expect(resolved.session).toBe(created)
  })

  it('refuses a session id that belongs to another resource', async () => {
    const mastra = createCrumMastra(repoEnv(), { storage: testStore() })
    await createSession(mastra, { agentId: 'crm-assistant', resourceId: resourceA, id: 'session-shared' })

    // The id is guessable; the resource is not. `getSession` keys by id alone,
    // so the comparison against the caller's resource is the only thing between
    // a signed-in user and another user's live run.
    const resolved = await resolveSession(mastra, {
      sessionId: 'session-shared',
      tenantId: TENANT,
      resourceId: resourceB,
    })

    expect(resolved).toEqual({ ok: false, reason: 'wrong-resource' })
  })

  it('recovers a stored conversation after a restart, bound to its thread', async () => {
    const mastra = createCrumMastra(repoEnv(), { storage: testStore() })
    const created = await createSession(mastra, { agentId: 'crm-assistant', resourceId: resourceA })
    const threadId = created.thread.getId()
    expect(threadId).toBeTruthy()

    // A different session id, so the live lookup misses and this is the recovery
    // path: `resumeOnly` must find the stored thread rather than start a new one.
    const resolved = await resolveSession(mastra, {
      sessionId: threadId!,
      tenantId: TENANT,
      resourceId: resourceA,
    })

    if (!resolved.ok) throw new Error(`expected recovery, got ${resolved.reason}`)
    expect(resolved.session.identity.getResourceId()).toBe(resourceA)
  })

  it('treats another resource\'s thread id as not started, which is what a nonexistent id also gets', async () => {
    const mastra = createCrumMastra(repoEnv(), { storage: testStore() })
    const created = await createSession(mastra, { agentId: 'crm-assistant', resourceId: resourceA })
    const foreignThread = created.thread.getId()!

    const mine = await resolveSession(mastra, {
      sessionId: foreignThread,
      tenantId: TENANT,
      resourceId: resourceB,
    })
    const nonsense = await resolveSession(mastra, {
      sessionId: 'thread-nobody-ever-had',
      tenantId: TENANT,
      resourceId: resourceB,
    })

    // Core only binds a thread when `thread.resourceId` equals the requested
    // resource, and reports the failure as "session not started" — the same
    // answer an unknown id gets, so probing for other people's threads tells
    // the caller nothing.
    expect(mine).toEqual({ ok: false, reason: 'not-started' })
    expect(nonsense).toEqual(mine)
  })

  it('refuses a resource that is not inside the claimed tenant', async () => {
    const mastra = createCrumMastra(repoEnv(), { storage: testStore() })

    const resolved = await resolveSession(mastra, {
      sessionId: 'anything',
      tenantId: TENANT,
      // built from another tenant's pair: the prefix check catches the caller
      // assembling the pair wrong instead of silently widening what it can read
      resourceId: `${OTHER}:user-c`,
    })

    expect(resolved).toEqual({ ok: false, reason: 'wrong-resource' })
  })

  it('reports a missing controller as a wiring fault instead of throwing', async () => {
    const mastra = createCrumMastra(repoEnv(), { storage: testStore() })

    const resolved = await resolveSession(mastra, {
      sessionId: 'session-live',
      tenantId: TENANT,
      resourceId: resourceA,
      agentId: 'no-such-controller',
    })

    expect(resolved).toEqual({ ok: false, reason: 'controller-missing' })
  })

  it('builds the resource id the chat middleware uses', () => {
    expect(resourceIdFor({ tenantId: TENANT, userId: 'user-a' })).toBe(`${TENANT}:user-a`)
  })
})
