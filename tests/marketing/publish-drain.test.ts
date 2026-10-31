/**
 * The drain loop's accounting rule: what the provider did is recorded once, and
 * a bookkeeping write that runs after it cannot take it back. A promote whose
 * deployment succeeded but whose bundle status write then failed must leave the
 * action row `succeeded`, because `marketing.retry_publish` exists to re-queue
 * failed rows and a retry over a live page is a second deployment.
 *
 * No database here: the fake Queryable answers the claim with one promote row and
 * records every statement, so the assertion is made against the SQL itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const liveFailure = vi.hoisted(() => ({ error: null as Error | null }))

vi.mock('@/db/marketing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/marketing')>()
  return {
    ...actual,
    markBundleLive: () =>
      liveFailure.error === null ? Promise.resolve(true) : Promise.reject(liveFailure.error),
  }
})

import { registerActionAdapter } from '@/marketing/outbox'
import { drainOnce } from '../../scripts/publish-drain'

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
 * statement lands in `recorded` in the order the drainer asked for it.
 */
function fakeClient() {
  const recorded: Recorded[] = []
  let claimed = false
  const client = {
    query<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
      recorded.push({ text, values })
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
    liveFailure.error = new Error('connection terminated unexpectedly')
    unregister = registerActionAdapter({
      name: 'promote_page',
      execute: () => Promise.resolve({ externalId: 'dep-1', url: 'https://dep-1.example.pages.dev' }),
    })
  })

  afterEach(() => {
    unregister()
    liveFailure.error = null
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
})
