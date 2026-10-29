import { describe, it, expect, afterAll } from 'vitest'
import { InMemoryStore } from '@mastra/core/storage'
import { PostgresStoreVNext } from '@mastra/pg'
import type { MastraDBMessage } from '@mastra/core/agent/message-list'
import { createCrumMastra } from '@/mastra/index'
import { buildMastraStorage } from '@/mastra/storage'
import { parseEnv } from '@/config/env'

/**
 * Spec §4 "Client-history protocol gate".
 *
 * The console `useChat` + `/chat/crm` proxy forwards the FULL message array on
 * every turn, so a single user turn re-sends earlier messages. Observational
 * memory assumes only the new message is sent; if the storage layer appended a
 * fresh row for each echo, long chats would fill with duplicate turns and the
 * history would reorder.
 *
 * Two tiers, run against the same scenario:
 *
 *  - In-memory store (always): an id-keyed Map, so this tier cannot observe a
 *    duplicate id by construction. What it DOES guard is that `saveMessages`
 *    preserves caller-supplied ids (does not re-mint them), persists every
 *    message, orders them by the client timestamp, and scopes recall to the
 *    resource.
 *  - Postgres store (skips without CRUM_INTEGRATION_DATABASE_URL; runs in CI):
 *    `mastra_messages.id` is a primary key, so this is the tier where a missing
 *    UPSERT actually fails rather than silently passing. It is the falsifiable
 *    half of the gate.
 *
 * The end-to-end proxy behaviour (a real model turn + OM filtering the echoed
 * history) is the remaining real-run step (plan Steps 4-5), needing
 * OPENROUTER_API_KEY; if that shows reordering or duplicates the fallback trims
 * the client payload to the last user message in
 * console/app/chat/[...path]/route.ts.
 */

// Distinct, deterministic timestamps: the client re-sends the SAME timestamp on
// every echo, so ordering and timestamp stability are assertable rather than
// decided by a live clock.
const T0 = Date.UTC(2026, 9, 29, 0, 0, 0)
const ts = (offsetSeconds: number) => new Date(T0 + offsetSeconds * 1000)

function msg(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  threadId: string,
  resourceId: string,
  createdAt: Date,
): MastraDBMessage {
  return {
    id,
    role,
    createdAt,
    content: { format: 2, parts: [{ type: 'text', text }] },
    threadId,
    resourceId,
  }
}

/**
 * Drives two overlapping full-history turns and asserts the stored ids come back
 * once each, in client-timestamp order, with timestamps unchanged by the echo.
 */
async function runGateScenario(
  mastra: ReturnType<typeof createCrumMastra>,
  threadId: string,
  resourceId: string,
) {
  const memory = mastra.getMemory('coreMemory')
  expect(memory).toBeDefined()

  await memory.createThread({ threadId, resourceId, title: 'gate' })

  // Turn 1: the client sends [u1]; the run stores the user message + one reply.
  await memory.saveMessages({
    messages: [
      msg('u1', 'user', 'gate: u1', threadId, resourceId, ts(0)),
      msg('a1', 'assistant', 'gate: a1', threadId, resourceId, ts(1)),
    ],
  })

  // Turn 2: the proxy echoes the FULL history [u1, a1] (same ids + timestamps)
  // and appends the new turn. Re-saving u1/a1 must not create second copies.
  await memory.saveMessages({
    messages: [
      msg('u1', 'user', 'gate: u1', threadId, resourceId, ts(0)),
      msg('a1', 'assistant', 'gate: a1', threadId, resourceId, ts(1)),
      msg('u2', 'user', 'gate: u2', threadId, resourceId, ts(2)),
      msg('a2', 'assistant', 'gate: a2', threadId, resourceId, ts(3)),
    ],
  })

  const stored = await memory.recall({ threadId, resourceId, perPage: 100 })
  const ids = stored.messages.map((m) => m.id)

  // No id appears twice despite u1/a1 being sent in both turns.
  expect(new Set(ids).size).toBe(ids.length)
  // Exactly the four expected messages, none dropped or re-minted.
  expect(new Set(ids)).toEqual(new Set(['u1', 'a1', 'u2', 'a2']))
  // total is counted before pagination, so it cannot be masked by perPage.
  expect(stored.total).toBe(4)
  // Ascending by the client timestamp: the echo did not reorder history.
  expect(ids).toEqual(['u1', 'a1', 'u2', 'a2'])
  // Re-sending u1 did not move its original timestamp.
  expect(new Date(stored.messages.find((m) => m.id === 'u1')!.createdAt).getTime()).toBe(ts(0).getTime())
}

describe('observational memory client-history gate (in-memory store)', () => {
  it('does not duplicate stored messages across overlapping full-history saves', async () => {
    const env = parseEnv({ NODE_ENV: 'development', CRUM_OM_ENABLED: 'true' })
    const mastra = createCrumMastra(env, { storage: new InMemoryStore({ id: 'om-client-history-gate' }) })
    await runGateScenario(mastra, 'gate-thread-mem', 'tenant-gate:user-gate')
  })
})

// The falsifiable tier: runs only where an integration Postgres is provided,
// matching the convention already used across tests/integration (§14.2). CI's
// Integration step exports CRUM_INTEGRATION_DATABASE_URL after db:migrate.
// parseEnv reads only its argument object, so the URL must be passed in there
// (setting process.env would NOT reach buildMastraStorage).
const pgUrl = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''

type CrumMemory = ReturnType<ReturnType<typeof createCrumMastra>['getMemory']>
let pgMemory: CrumMemory | null = null
let pgThreadId = ''

describe.skipIf(!pgUrl)('observational memory client-history gate (postgres store)', () => {
  afterAll(async () => {
    // Leave the shared integration schema as we found it.
    if (pgMemory && pgThreadId) await pgMemory.deleteThread(pgThreadId).catch(() => {})
  })

  it('does not duplicate stored messages across overlapping full-history saves', async () => {
    const env = parseEnv({ NODE_ENV: 'development', CRUM_OM_ENABLED: 'true', DATABASE_URL: pgUrl })
    const storage = buildMastraStorage(env)
    // Defensive: prove this tier really exercises the PK-backed store, not the
    // id-keyed Map the in-memory tier already covers.
    expect(storage).toBeInstanceOf(PostgresStoreVNext)
    pgThreadId = `gate-thread-pg-${Date.now()}`
    const mastra = createCrumMastra(env, { storage })
    pgMemory = mastra.getMemory('coreMemory')
    await runGateScenario(mastra, pgThreadId, `tenant-gate:${Date.now()}`)
  })
})
