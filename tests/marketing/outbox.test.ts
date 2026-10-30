import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BundleNotApprovableError,
  commitBundleApproval,
  DERIVED_ACTION_NAMES,
  deriveActions,
  isExecutable,
  registerActionAdapter,
  UNMAPPED_ACTION_NAMES,
  unreadPlanColumns,
} from '@/marketing/outbox'

const TENANT = '11111111-1111-4111-8111-111111111111'
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const RECEIPT = '99999999-9999-4999-8999-999999999999'

function bundleRow(over: Record<string, unknown> = {}) {
  return {
    id: BUNDLE,
    status: 'staged',
    objective: 'outreach_support',
    funnel_plan: null,
    media_plan: null,
    ...over,
  }
}

function clientReturning(rows: unknown[]) {
  // The fake mirrors prospect-merge.test.ts's stubQueries: a plain function that
  // hands back a resolved Promise, so `await client.query(...)` sees the branch
  // taken on the SQL text. `_values` is captured only so the enqueue params are
  // recorded for assertion, hence the leading underscore the lint config allows.
  const query = vi.fn((sql: string, _values?: unknown[]): Promise<{ rows: unknown[] }> => {
    if (sql.includes('FROM marketing_bundles')) return Promise.resolve({ rows })
    return Promise.resolve({ rows: [{ id: BUNDLE }] })
  })
  return { query, sqls: () => query.mock.calls.map((c) => c[0]) }
}

type FakeClient = ReturnType<typeof clientReturning>

async function approve(client: FakeClient): Promise<string> {
  return await commitBundleApproval(client as never, {
    tenantId: TENANT,
    bundleId: BUNDLE,
    receiptId: RECEIPT,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('deriveActions', () => {
  it('reads a page out of the funnel plan', () => {
    const actions = deriveActions({
      id: BUNDLE,
      funnelPlan: { page: { slug: '/physio-free-scan', title: 'Free scan' } },
      mediaPlan: null,
    })
    expect(actions.map((a) => a.action)).toEqual(['publish_page'])
  })

  it('reads a campaign out of the media plan', () => {
    const actions = deriveActions({
      id: BUNDLE,
      funnelPlan: null,
      mediaPlan: { campaigns: [{ name: 'melbourne-physio', startPaused: true }] },
    })
    expect(actions.map((a) => a.action)).toEqual(['create_campaign'])
  })

  it('orders the page before the campaign, because a link must land somewhere', () => {
    const actions = deriveActions({
      id: BUNDLE,
      funnelPlan: { page: { slug: '/free-scan' } },
      mediaPlan: { campaigns: [{ name: 'x' }] },
    })
    expect(actions.map((a) => a.action)).toEqual(['publish_page', 'create_campaign'])
  })

  it('derives nothing from an outreach support bundle, which is why slice 1 can approve one', () => {
    expect(deriveActions({ id: BUNDLE, funnelPlan: null, mediaPlan: null })).toEqual([])
  })

  it('ignores a plan that is not an object', () => {
    expect(deriveActions({ id: BUNDLE, funnelPlan: 'nonsense', mediaPlan: [1, 2] })).toEqual([])
  })
})

describe('the mapped action sets', () => {
  it('names the actions no slice 1 plan can ask for', () => {
    expect(UNMAPPED_ACTION_NAMES).toEqual(['unpublish_page', 'set_campaign_status'])
  })

  it('derives only actions it declared it can derive', () => {
    const actions = deriveActions({
      id: BUNDLE,
      funnelPlan: { page: { slug: '/x' }, form: { fields: [] }, tracking: { pixel: 'none' } },
      mediaPlan: { objective: 'leads', audience: 'clinics', placements: ['feed'], campaigns: [{ name: 'x' }] },
    })
    expect(actions.every((a) => DERIVED_ACTION_NAMES.includes(a.action))).toBe(true)
    expect(actions.map((a) => a.action)).toEqual(['publish_page', 'create_campaign'])
  })
})

describe('unreadPlanColumns', () => {
  it('reads a bundle with no plans, which is the slice 1 outreach support case', () => {
    expect(unreadPlanColumns({ funnelPlan: null, mediaPlan: null })).toEqual([])
  })

  it('reads an explicit null page and an empty campaign list, because both say do nothing', () => {
    expect(unreadPlanColumns({ funnelPlan: { page: null }, mediaPlan: { campaigns: [] } })).toEqual([])
  })

  it('refuses a funnel plan that carries no page container at all', () => {
    expect(unreadPlanColumns({ funnelPlan: { form: { fields: [] } }, mediaPlan: null })).toEqual(['funnel_plan'])
  })

  it('refuses a page with no slug, because there is nothing for an adapter to publish', () => {
    expect(unreadPlanColumns({ funnelPlan: { page: { title: 'Free scan' } }, mediaPlan: null })).toEqual(['funnel_plan'])
  })

  it('refuses a plan stored as prose instead of an object', () => {
    expect(unreadPlanColumns({ funnelPlan: 'we will decide later', mediaPlan: null })).toEqual(['funnel_plan'])
  })

  it('refuses a media plan whose campaigns key is not a list', () => {
    expect(unreadPlanColumns({ funnelPlan: null, mediaPlan: { campaigns: 'one good campaign' } })).toEqual(['media_plan'])
  })
})

describe('the slice 1 executable set', () => {
  it('has no adapter registered, so nothing an agent asks for can run', () => {
    expect(isExecutable('publish_page')).toBe(false)
    expect(isExecutable('create_campaign')).toBe(false)
  })

  it('treats an action as executable only while its adapter is registered', () => {
    const unregister = registerActionAdapter({
      name: 'publish_page',
      execute: () => Promise.resolve({ externalId: 'https://example.test/free-scan' }),
    })
    expect(isExecutable('publish_page')).toBe(true)
    unregister()
    expect(isExecutable('publish_page')).toBe(false)
  })
})

describe('commitBundleApproval', () => {
  let bundle: Record<string, unknown>

  beforeEach(() => {
    bundle = bundleRow()
  })

  it('locks the row for this tenant before deciding anything', async () => {
    const client = clientReturning([bundle])
    await approve(client)
    const [select] = client.sqls()
    expect(select).toContain('FOR UPDATE')
    expect(select).toContain('tenant_id = $2')
  })

  it('refuses to approve a bundle with a page, because no publish adapter exists yet', async () => {
    const client = clientReturning([bundleRow({ funnel_plan: { page: { slug: '/free-scan' } } })])
    await expect(approve(client)).rejects.toThrow(/publish_page/)
    expect(client.sqls().some((sql) => sql.includes("SET status = 'approved'"))).toBe(false)
  })

  it('names every blocked action in one message', async () => {
    const client = clientReturning([
      bundleRow({ funnel_plan: { page: { slug: '/free-scan' } }, media_plan: { campaigns: [{ name: 'x' }] } }),
    ])
    await expect(approve(client)).rejects.toThrow(/publish_page.*create_campaign|create_campaign.*publish_page/)
  })

  it('refuses a bundle whose plan it cannot read, before it asks which adapters exist', async () => {
    const client = clientReturning([bundleRow({ funnel_plan: { page: { title: 'Free scan' } } })])
    await expect(approve(client)).rejects.toThrow(/funnel_plan/)
    expect(client.sqls().some((sql) => sql.includes("SET status = 'approved'"))).toBe(false)
  })

  it('refuses a bundle that is not still awaiting approval', async () => {
    const client = clientReturning([bundleRow({ status: 'live' })])
    await expect(approve(client)).rejects.toThrow(BundleNotApprovableError)
    expect(client.sqls().some((sql) => sql.includes('marketing_bundles'))).toBe(true)
  })

  it('refuses a draft bundle, because the owner was never shown it staged', async () => {
    const client = clientReturning([bundleRow({ status: 'draft' })])
    await expect(approve(client)).rejects.toThrow(BundleNotApprovableError)
  })

  it('refuses a bundle the tenant cannot see', async () => {
    const client = clientReturning([])
    await expect(approve(client)).rejects.toThrow(/not visible/)
  })

  it('approves a content-only bundle and enqueues nothing', async () => {
    const client = clientReturning([bundle])
    expect(await approve(client)).toBe(BUNDLE)
    expect(client.sqls().some((sql) => sql.includes("SET status = 'approved'"))).toBe(true)
    expect(client.sqls().some((sql) => sql.includes('INSERT INTO marketing_actions'))).toBe(false)
  })

  it('enqueues each action with the receipt that authorised it, once an adapter exists', async () => {
    const unregister = registerActionAdapter({
      name: 'publish_page',
      execute: () => Promise.resolve({ externalId: 'x' }),
    })
    // try/finally: an assertion failure below must not leave publish_page
    // registered for the rest of the file, where every other case expects the
    // slice 1 registry to be empty.
    try {
      const client = clientReturning([bundleRow({ funnel_plan: { page: { slug: '/free-scan' } } })])
      await expect(approve(client)).resolves.toBe(BUNDLE)
      const insert = client.query.mock.calls.find((c) => c[0].includes('INSERT INTO marketing_actions'))
      expect(insert?.[1]).toEqual([TENANT, BUNDLE, 'publish_page', JSON.stringify({ slug: '/free-scan' }), RECEIPT])
    } finally {
      unregister()
    }
  })
})
