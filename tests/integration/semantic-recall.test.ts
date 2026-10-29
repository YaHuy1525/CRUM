import { describe, it, expect, afterAll } from 'vitest'
import type { MastraDBMessage } from '@mastra/core/agent/message-list'
import { createCrumMastra } from '@/mastra/index'
import { parseEnv } from '@/config/env'

/**
 * Task 8: cross-tenant semantic-recall leak guard (spec §5 success criterion #2;
 * research doc §4/§6 Tier A).
 *
 * Tier A keeps ONE shared `mastra_memory` vector schema for every tenant, so
 * isolation is enforced by the query filter, not by separate tables. The shipped
 * primary predicate is the resource scope: semantic recall builds
 * `{ resource_id: <resourceId> }` and CRUM's resourceId is server-derived as
 * `${tenantId}:${userId}` (sessions.ts), prefix-enforced on every read. This test
 * falsifies a cross-tenant leak by planting a tenant-B fact and asserting a
 * tenant-A recall never surfaces it — while still recalling tenant-A's own fact
 * from a DIFFERENT thread, proving the cross-thread mechanism actually works
 * rather than returning an empty set.
 *
 * RUNNABILITY: this is the live-only tier. Unlike om-client-history.test.ts (which
 * disables recall so it never embeds), semantic recall embeds every saved message,
 * so it needs BOTH a reachable Postgres with pgvector AND a working embedder. CI
 * deliberately pins the embedder to a dead placeholder (crum-ci.yml:34-35) because
 * no other CI step embeds, so CI would fail — not skip — if this ran there. A
 * developer therefore opts in explicitly with CRUM_SEMANTIC_RECALL_LIVE=true once
 * both preconditions hold. Without the opt-in the suite reports "skipped", never a
 * false "passed" (research doc §6 note assumed the DB guard alone was enough; the
 * dead-CI-embedder forces this second guard — recorded as a §6 correction).
 *
 * The defense-in-depth SECOND predicate (thread.metadata.tenantId stamped on write
 * + a per-request memoryConfig.semanticRecall.filter) is NOT exercised here: CRUM
 * owns no turn-invocation seam that carries a memoryConfig (turns flow through
 * Mastra's native AgentController; threads are created lazily), so wiring it is a
 * net-new architectural change tracked separately, not a test-only concern.
 */

const pgUrl = process.env.CRUM_INTEGRATION_DATABASE_URL ?? ''
const live = pgUrl !== '' && process.env.CRUM_SEMANTIC_RECALL_LIVE === 'true'

// Unique per run so parallel/CI reruns never collide, yet deterministic within a
// single run so the save and the recall reference the exact same resources.
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const RESOURCE_A = `tenant-a-${stamp}:user-1`
const RESOURCE_B = `tenant-b-${stamp}:user-2`
const THREAD_A1 = `a-1-${stamp}`
const THREAD_A2 = `a-2-${stamp}`
const THREAD_B1 = `b-1-${stamp}`

function msg(id: string, text: string, threadId: string, resourceId: string): MastraDBMessage {
  return {
    id,
    role: 'user',
    createdAt: new Date(),
    content: { format: 2, parts: [{ type: 'text', text }] },
    threadId,
    resourceId,
  }
}

describe.skipIf(!live)('semantic recall cross-tenant leak guard (live postgres + embedder)', () => {
  const memory = createCrumMastra(
    parseEnv({ NODE_ENV: 'development', CRUM_RECALL_ENABLED: 'true', DATABASE_URL: pgUrl }),
  ).getMemory('coreMemory')

  afterAll(async () => {
    if (!memory) return
    for (const id of [THREAD_A1, THREAD_A2, THREAD_B1]) {
      await memory.deleteThread(id).catch(() => {})
    }
  })

  it('recalls a same-resource fact across threads and never a second tenant\'s', async () => {
    expect(memory).not.toBeNull()
    if (!memory) return

    // saveMessages rejects unknown threads ("Thread ... not found"), so each
    // thread must exist and be owned by its resource before its messages land.
    const now = new Date()
    for (const [id, resourceId] of [
      [THREAD_A1, RESOURCE_A],
      [THREAD_A2, RESOURCE_A],
      [THREAD_B1, RESOURCE_B],
    ] as const) {
      await memory.saveThread({ thread: { id, resourceId, title: id, createdAt: now, updatedAt: now } })
    }

    // Tenant A stores its renewal fact on one thread...
    await memory.saveMessages({
      messages: [msg(`m-a1-${stamp}`, 'Our renewal date is every March 1st.', THREAD_A1, RESOURCE_A)],
    })
    // ...and an unrelated opener on a second thread so the recall query runs from
    // a real, resource-owned thread distinct from the one holding the fact.
    await memory.saveMessages({
      messages: [msg(`m-a2-${stamp}`, 'Hi, I have a billing question.', THREAD_A2, RESOURCE_A)],
    })
    // Tenant B stores a decoy renewal fact under a different resource id.
    await memory.saveMessages({
      messages: [msg(`m-b1-${stamp}`, 'Their renewal date is every November 9th.', THREAD_B1, RESOURCE_B)],
    })

    // Recall FROM tenant A's second thread (which never contains "March 1st").
    // A hit proves cross-thread semantic recall works within the resource scope;
    // the absence of "November 9th" proves tenant B is not leaked across it.
    const recalled = await memory.recall({
      threadId: THREAD_A2,
      resourceId: RESOURCE_A,
      vectorSearchString: 'when is the renewal date?',
      perPage: 5,
      hideSignals: true,
    })
    const text = JSON.stringify(recalled.messages)

    expect(text).toContain('March 1st')
    expect(text).not.toContain('November 9th')
  }, 90_000)
})
