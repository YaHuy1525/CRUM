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
 *
 * The second block is the registration the loop depends on. A drainer can only
 * run what this process has registered, and for three slices it registered the
 * page lane and nothing else, which quietly failed every campaign row an owner
 * approved. That is measured here rather than in the boot test, because boot is a
 * different process and the point of the defect is which process is which.
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

import { isExecutable, registerActionAdapter } from '@/marketing/outbox'
import { claimNextQueued, drainOnce, registerDrainAdapters } from '../../scripts/publish-drain'

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

// What Task 16's approval actually writes, in the shape the queue holds it: the
// adapter reads the payload off the row, so this is the row a deployment gets.
const CREATE_ROW = {
  id: ACTION,
  tenant_id: TENANT,
  bundle_id: BUNDLE,
  action: 'create_campaign',
  payload: {
    adAccountId: 'act_111',
    name: 'spring-offer',
    objective: 'OUTCOME_LEADS',
    startPaused: true,
    dailyCeilingMinor: 2000,
  },
  attempts: 1,
}

interface Recorded {
  text: string
  values: unknown[]
}

/**
 * One claim, then nothing: the second pass over the loop must see an empty
 * result or the test would hang on a fake that always finds a row. Every
 * statement lands in `recorded` in the order the drainer asked for it. `failOn`
 * makes the statement it matches reject, which is how a database failure at a
 * chosen point in the pass is played back, and `row` is what the claim returns.
 */
function fakeClient(failOn?: RegExp, row: Record<string, unknown> = PROMOTE_ROW) {
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
      return Promise.resolve({ rows: [row] as unknown as T[] })
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

/**
 * What the publisher's process can run, read from the settings a host would set.
 *
 * R-39 is the reason this block exists. An owner approved a scale recommendation,
 * the approval wrote a correct campaign row, and the documented publisher recorded
 * `no_adapter` against it, because main() registered the two page adapters and
 * Meta's pair was only ever mapped by the server at boot (src/mastra/index.ts:174).
 * The registry is per process (src/marketing/outbox.ts:70), so the queue could hold
 * work this process could name and not run, and no single file showed the gap. The
 * question a deployment answers is the one asked below: after reading its own
 * environment, can this process run every action the queue can hold?
 */
describe('registerDrainAdapters', () => {
  const PAGES = {
    CRUM_CLOUDFLARE_ACCOUNT_ID: 'cf-account',
    CRUM_CLOUDFLARE_PAGES_PROJECT: 'crum-bundles',
    CRUM_CLOUDFLARE_API_TOKEN: 'cf-token-not-a-real-one',
    CRUM_PAGES_PRODUCTION_BRANCH: 'main',
  }
  const META = {
    CRUM_META_ADS_ACCESS_TOKEN: 'meta-token-not-a-real-one',
    CRUM_META_AD_ACCOUNTS: '["act_111"]',
  }
  const EVERY_ACTION = ['publish_page', 'promote_page', 'create_campaign', 'set_campaign_status'] as const

  let handles: Array<() => void> = []
  const requested: string[] = []

  beforeEach(() => {
    // No provider and no network: fetch is replaced for the whole case, so a call
    // that reached outside the adapter would land here and be counted. Every
    // registration below is checked by asking the map, and one case is checked by
    // draining, which is the only way to prove the entry the map hands back is the
    // adapter the config built rather than a name with nothing under it.
    requested.length = 0
    vi.stubGlobal('fetch', (input: unknown) => {
      requested.push(String(input))
      return Promise.resolve(new Response(JSON.stringify({ id: '23842653876', success: true }), { status: 200 }))
    })
  })

  afterEach(() => {
    for (const off of handles) off()
    handles = []
    vi.unstubAllGlobals()
  })

  it('maps all four queued actions in the process that has to drain them', () => {
    const registration = registerDrainAdapters({ ...PAGES, ...META })
    handles = registration.handles
    expect(handles).toHaveLength(4)
    for (const name of EVERY_ACTION) {
      expect(isExecutable(name)).toBe(true)
    }
    // The handles undo exactly what was added, which is what keeps the next case
    // honest: a leaked registration would make an unconfigured host look configured.
    for (const off of handles) off()
    for (const name of EVERY_ACTION) {
      expect(isExecutable(name)).toBe(false)
    }
    handles = []
  })

  it('drains a campaign row rather than recording no_adapter against it', async () => {
    const registration = registerDrainAdapters({ ...PAGES, ...META })
    handles = registration.handles
    expect(registration.metaConfigured).toBe(true)

    const { client, recorded } = fakeClient(undefined, CREATE_ROW)
    const counts = await drainOnce({ pool: client })

    expect(counts).toEqual({ ran: 1, succeeded: 1, failed: 0 })
    expect(requested).toEqual(['https://graph.facebook.com/v18.0/act_111/campaigns'])
    const statements = recorded.map((entry) => entry.text)
    expect(statements.some((text) => /SET status = 'succeeded'/.test(text))).toBe(true)
    // The reap statement also writes 'failed', so the assertion is about the
    // recordFailure shape, which is what a no_adapter refusal would have produced.
    expect(statements.some((text) => /SET status = 'failed', last_error = \$2/.test(text))).toBe(false)
  })

  it('says which lane a half-configured host is missing, and registers only the other', () => {
    // Both flags are what main() warns on, so they have to be per lane rather than
    // one boolean over the whole registry: "no Pages config" and "no Meta config"
    // are different operators' problems, and a host with one lane running is not a
    // host that registered nothing.
    const pagesOnly = registerDrainAdapters(PAGES)
    handles = pagesOnly.handles
    expect(pagesOnly).toMatchObject({ pageHostConfigured: true, metaConfigured: false })
    expect(handles).toHaveLength(2)
    expect(isExecutable('promote_page')).toBe(true)
    expect(isExecutable('create_campaign')).toBe(false)
    expect(isExecutable('set_campaign_status')).toBe(false)
  })

  it('reports the page lane as missing when only Meta is configured', () => {
    const metaOnly = registerDrainAdapters(META)
    handles = metaOnly.handles
    expect(metaOnly).toMatchObject({ pageHostConfigured: false, metaConfigured: true })
    expect(handles).toHaveLength(2)
    expect(isExecutable('publish_page')).toBe(false)
    expect(isExecutable('create_campaign')).toBe(true)
  })
})
