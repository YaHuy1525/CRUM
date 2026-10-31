/**
 * The drain loop's accounting rule: what the provider did is recorded once, and
 * a bookkeeping write that runs after it cannot take it back. A promote whose
 * deployment succeeded but whose bundle status write then failed must leave the
 * action row `succeeded`, because `marketing.retry_publish` exists to re-queue
 * failed rows and a retry over a live page is a second deployment.
 *
 * Also why the reaper can only be measuring claim time: it runs before the claim
 * and compares `executed_at`, which the claim stamps. A row queued hours ago and
 * claimed a second ago has been in flight for a second, and the case that proves
 * Postgres agrees with that lives in `tests/integration/marketing-publish.test.ts`,
 * where a real row queued two hours before its claim survives a reap. A fake
 * Queryable records the statement but cannot evaluate its WHERE clause, so
 * asserting the outcome here would be asserting the fake, not the drainer.
 *
 * No database here: the fake answers the claim with one promote row and records
 * every statement, so the assertion is made against the SQL itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const live = vi.hoisted(() => ({ thrown: null as Error | null, marked: true }))

vi.mock('@/db/marketing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/marketing')>()
  return {
    ...actual,
    markBundleLive: () => {
      if (live.thrown !== null) return Promise.reject(live.thrown)
      return Promise.resolve(live.marked)
    },
  }
})

import { registerActionAdapter } from '@/marketing/outbox'
import { claimNextQueued, drainOnce } from '../../scripts/publish-drain'

const TENANT = '11111111-1111-4111-8111-111111111111'
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const ACTION = '44444444-4444-4444-8444-444444444444'

const PROMOTE_ROW = {
  id: ACTION,
  tenant_id: TENANT,
  bundle_id: BUNDLE,
  action: 'promote_page',
  payload: { bundleId: BUNDLE, slug: 'free-scan' },
  attempts: 1,
}

interface Recorded {
  text: string
  values: unknown[]
}

/**
 * One claim, then nothing: the second pass over the loop must see an empty
 * result or the test would hang on a fake that can always find a row. Every
 * statement lands in `recorded` in the order the drainer asked for it. `failOn`
 * makes the statement it matches reject, which is how a database failure at a
 * chosen point in the pass is played back.
 */
function fakeClient(failOn?: RegExp) {
  const recorded: Recorded[] = []
  let claimed = false
  const client = {
    query<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
      recorded.push({ text, values })
      if (failOn !== undefined && failOn.test(text)) {
        return Promise.reject(new Error('connection reset by peer'))
      }
      if (!text.includes('RETURNING id, tenant_id, bundle_id, action, payload, attempts')) {
        return Promise.resolve({ rows: [] })
      }
      if (claimed) return Promise.resolve({ rows: [] })
      claimed = true
      // The claim is the one statement whose row the drainer reads back; every
      // other statement here is an UPDATE with nothing to return.
      return Promise.resolve({ rows: [PROMOTE_ROW] as unknown as T[] })
    },
  }
  return { client, recorded }
}

describe('drainOnce', () => {
  let unregister: () => void

  beforeEach(() => {
    live.thrown = new Error('connection terminated unexpectedly')
    live.marked = true
    unregister = registerActionAdapter({
      name: 'promote_page',
      execute: () => Promise.resolve({ externalId: 'dep-1', url: 'https://dep-1.example.pages.dev' }),
    })
  })

  afterEach(() => {
    unregister()
    live.thrown = null
    live.marked = true
    vi.restoreAllMocks()
  })

  it('keeps a succeeded promote succeeded when marking the bundle live throws', async () => {
    const { client, recorded } = fakeClient()
    const complaints: string[] = []
    vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      complaints.push(typeof message === 'string' ? message : '')
    })

    const counts = await drainOnce({ pool: client })

    expect(counts).toEqual({ ran: 1, succeeded: 1, failed: 0 })
    const statements = recorded.map((entry) => entry.text)
    expect(statements.some((text) => /SET status = 'succeeded'/.test(text))).toBe(true)
    // The reap statement also writes 'failed', so the assertion is about the
    // recordFailure shape: that one is parameterised by the action id.
    expect(statements.some((text) => /SET status = 'failed', last_error = \$2/.test(text))).toBe(false)
    expect(complaints.some((line) => line.includes(BUNDLE) && line.includes(ACTION))).toBe(true)
  })

  it('names a bundle left behind when marking it live matched no row', async () => {
    // markBundleLive answers false when the bundle's status no longer allows
    // live. The page is live and the bundle is not, and no exception exists to
    // carry that, so the only record of it is the line.
    live.thrown = null
    live.marked = false
    const { client, recorded } = fakeClient()
    const complaints: string[] = []
    vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      complaints.push(typeof message === 'string' ? message : '')
    })

    const counts = await drainOnce({ pool: client })

    // The provider answered, so the row still says succeeded and the pass counts
    // no failure: the bundle status is the leftover, not the action.
    expect(counts).toEqual({ ran: 1, succeeded: 1, failed: 0 })
    expect(recorded.map((entry) => entry.text).some((text) => /SET status = 'failed', last_error = \$2/.test(text))).toBe(false)
    expect(
      complaints.some((line) => line.includes(BUNDLE) && line.includes(ACTION) && /not live/.test(line)),
    ).toBe(true)
  })

  it('leaves a row running when the success itself cannot be written', async () => {
    // The provider answered and the adapter returned. A database failure while
    // writing that answer down is not a provider failure: reporting it as one
    // would leave a failed row over a page that exists, and its retry would
    // deploy the same page again. The row stays running for the reaper.
    live.thrown = null
    const { client, recorded } = fakeClient(/SET status = 'succeeded'/)

    await expect(drainOnce({ pool: client })).rejects.toThrow('connection reset by peer')

    expect(recorded.map((entry) => entry.text).some((text) => /SET status = 'succeeded'/.test(text))).toBe(true)
    expect(recorded.map((entry) => entry.text).some((text) => /SET status = 'failed', last_error = \$2/.test(text))).toBe(false)
  })

  it('stamps executed_at at claim in both branches, after a reap that reads it', async () => {
    // A row queued an hour ago and claimed now has been in flight for no time at
    // all. The reaper can only see that if the claim writes the claim time down,
    // and if its window is measured from that column rather than from created_at.
    const { client, recorded } = fakeClient()

    // The promote follow-up succeeds here; this case is about the claim and the
    // reap, so nothing should be complaining on stderr.
    live.thrown = null
    await drainOnce({ pool: client })
    expect(recorded[0]?.text).toMatch(/SET status = 'failed'/)
    expect(recorded[0]?.text).toMatch(/COALESCE\(executed_at, created_at\) < now\(\)/)
    expect(recorded[1]?.text).toMatch(/SET status = 'running', attempts = attempts \+ 1, executed_at = now\(\)/)

    // The scoped branch is the other claim statement and needs the same stamp;
    // drainOnce only ever reaches one branch per call.
    const direct = fakeClient()
    await claimNextQueued(direct.client, BUNDLE)
    await claimNextQueued(direct.client)
    const claims = direct.recorded.filter((entry) => /SET status = 'running'/.test(entry.text))
    expect(claims).toHaveLength(2)
    for (const claim of claims) expect(claim.text).toMatch(/executed_at = now\(\)/)
  })
})
