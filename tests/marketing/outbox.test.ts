import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BundleNotApprovableError,
  commitBundleApproval,
  DERIVED_ACTION_NAMES,
  deriveActions,
  HUMAN_INITIATED_ACTION_NAMES,
  isExecutable,
  MARKETING_ACTION_NAMES,
  pageSlugOf,
  registerActionAdapter,
  slotProblemCheck,
  UNMAPPED_ACTION_NAMES,
  unreadPlanColumns,
} from '@/marketing/outbox'
import { SlugProblemError, resolveSite, siteHashOf } from '@/marketing/site'

const TENANT = '11111111-1111-4111-8111-111111111111'
const BUNDLE = '33333333-3333-4333-8333-333333333333'
const DOC = '44444444-4444-4444-8444-444444444444'
const RECEIPT = '99999999-9999-4999-8999-999999999999'

// The one-page fixture these commit cases share, and the hash a stage would have
// recorded for it. Since the approval compares the two hashes unconditionally, a
// case that must get past the re-check hands this over; null now means the
// staged payload identified no page at all, which refuses.
const PAGE_TEXT = '<h1>Free scan</h1>'
const PAGE_HASH = siteHashOf(
  resolveSite('free-scan', [{ id: 'a1', kind: 'page_html', textContent: PAGE_TEXT }]),
)

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

function clientReturning(
  rows: unknown[],
  artifacts: unknown[] = [],
  assetFiles: unknown[] = [],
) {
  // The fake mirrors prospect-merge.test.ts's stubQueries: a plain function that
  // hands back a resolved Promise, so `await client.query(...)` sees the branch
  // taken on the SQL text. `_values` is captured only so the enqueue params are
  // recorded for assertion, hence the leading underscore the lint config allows.
  const query = vi.fn((sql: string, _values?: unknown[]): Promise<{ rows: unknown[] }> => {
    if (sql.includes('FROM marketing_bundles')) return Promise.resolve({ rows })
    // The commit re-derives the file set inside the lock, so any case that gets
    // past the unread check issues this SELECT. Answering it with bundle rows
    // would make the fake derive artifacts from columns that do not exist.
    if (sql.includes('FROM marketing_artifacts')) return Promise.resolve({ rows: artifacts })
    // The loader's second read, answered separately because a page that names an
    // asset has to get either real bytes or a real empty, not the default row.
    if (sql.includes('FROM document_files')) return Promise.resolve({ rows: assetFiles })
    return Promise.resolve({ rows: [{ id: BUNDLE }] })
  })
  return { query, sqls: () => query.mock.calls.map((c) => c[0]) }
}

type FakeClient = ReturnType<typeof clientReturning>

async function approve(
  client: FakeClient,
  expectedSiteHash: string | null = null,
): Promise<string> {
  return await commitBundleApproval(client as never, {
    tenantId: TENANT,
    bundleId: BUNDLE,
    receiptId: RECEIPT,
    // Null by default: the cases that omit the second argument are about the
    // lock and the refusals, and have no page to identify. A case whose bundle
    // has a page passes the hash a stage recorded, because null there now means
    // the staged payload named nothing and the approval refuses.
    expectedSiteHash,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('deriveActions', () => {
  it('reads a page out of the funnel plan', () => {
    const actions = deriveActions(
      {
        id: BUNDLE,
        funnelPlan: { page: { slug: 'physio-free-scan', title: 'Free scan' } },
        mediaPlan: null,
      },
      [{ id: 'a1', kind: 'page_html', textContent: '<h1>Free scan</h1>' }],
    )
    expect(actions.map((a) => a.action)).toEqual(['publish_page'])
  })

  it('reads a campaign out of the media plan', () => {
    const actions = deriveActions(
      {
        id: BUNDLE,
        funnelPlan: null,
        mediaPlan: { campaigns: [{ name: 'melbourne-physio', startPaused: true }] },
      },
      [],
    )
    expect(actions.map((a) => a.action)).toEqual(['create_campaign'])
  })

  it('orders the page before the campaign, because a link must land somewhere', () => {
    const actions = deriveActions(
      {
        id: BUNDLE,
        funnelPlan: { page: { slug: 'free-scan' } },
        mediaPlan: { campaigns: [{ name: 'x' }] },
      },
      [{ id: 'a1', kind: 'page_html', textContent: '<h1>Free scan</h1>' }],
    )
    expect(actions.map((a) => a.action)).toEqual(['publish_page', 'create_campaign'])
  })

  it('derives nothing from an outreach support bundle, which is why slice 1 can approve one', () => {
    expect(deriveActions({ id: BUNDLE, funnelPlan: null, mediaPlan: null }, [])).toEqual([])
  })

  it('ignores a plan that is not an object', () => {
    expect(deriveActions({ id: BUNDLE, funnelPlan: 'nonsense', mediaPlan: [1, 2] }, [])).toEqual([])
  })
})

describe('action name vocabulary', () => {
  it('accounts for every declared name exactly once', () => {
    const all = [...MARKETING_ACTION_NAMES].sort()
    const parts = [
      ...DERIVED_ACTION_NAMES,
      ...HUMAN_INITIATED_ACTION_NAMES,
      ...UNMAPPED_ACTION_NAMES,
    ].sort()
    expect(parts).toEqual(all)
    expect(new Set(parts).size).toBe(parts.length)
  })

  it('derives only actions it declared it can derive', () => {
    const actions = deriveActions(
      {
        id: BUNDLE,
        funnelPlan: { page: { slug: 'x' }, form: { fields: [] }, tracking: { pixel: 'none' } },
        mediaPlan: { objective: 'leads', audience: 'clinics', placements: ['feed'], campaigns: [{ name: 'x' }] },
      },
      [{ id: 'a1', kind: 'page_html', textContent: '<h1>hi</h1>' }],
    )
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
    const client = clientReturning(
      [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } } })],
      [{ id: 'a1', kind: 'page_html', text_content: PAGE_TEXT }],
    )
    await expect(approve(client, PAGE_HASH)).rejects.toThrow(/publish_page/)
    expect(client.sqls().some((sql) => sql.includes("SET status = 'approved'"))).toBe(false)
  })

  it('names every blocked action in one message', async () => {
    const client = clientReturning(
      [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } }, media_plan: { campaigns: [{ name: 'x' }] } })],
      [{ id: 'a1', kind: 'page_html', text_content: PAGE_TEXT }],
    )
    await expect(approve(client, PAGE_HASH)).rejects.toThrow(/publish_page.*create_campaign|create_campaign.*publish_page/)
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

  it('approves when the bytes still hash to what the review was shown', async () => {
    // The control for the refusal below: a re-check that refused every page
    // bundle would pass that case without ever comparing anything.
    const unregister = registerActionAdapter({
      name: 'publish_page',
      execute: () => Promise.resolve({ externalId: 'x' }),
    })
    try {
      const artifacts = [{ id: 'a1', kind: 'page_html', text_content: '<h1>Free scan</h1>' }]
      const client = clientReturning(
        [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } } })],
        artifacts,
      )
      const expectedSiteHash = siteHashOf(
        resolveSite('free-scan', [{ id: 'a1', kind: 'page_html', textContent: '<h1>Free scan</h1>' }]),
      )
      await expect(
        commitBundleApproval(client as never, {
          tenantId: TENANT,
          bundleId: BUNDLE,
          receiptId: RECEIPT,
          expectedSiteHash,
        }),
      ).resolves.toBe(BUNDLE)
    } finally {
      unregister()
    }
  })

  it('enqueues each action with the receipt that authorised it, once an adapter exists', async () => {
    const unregister = registerActionAdapter({
      name: 'publish_page',
      execute: () => Promise.resolve({ externalId: 'x' }),
    })
    const artifacts = [{ id: 'a1', kind: 'page_html', text_content: PAGE_TEXT }]
    // try/finally: an assertion failure below must not leave publish_page
    // registered for the rest of the file, where every other case expects the
    // slice 1 registry to be empty.
    try {
      const client = clientReturning(
        [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } } })],
        artifacts,
      )
      await expect(approve(client, PAGE_HASH)).resolves.toBe(BUNDLE)
      const insert = client.query.mock.calls.find((c) => c[0].includes('INSERT INTO marketing_actions'))
      // The hash is computed from the fixture's bytes rather than pasted, so an
      // outbox that enqueued a slug or a constant fails here. Same inputs the
      // commit re-derives under the lock: path `free-scan/index.html`, those bytes.
      const expectedPayload = {
        bundleId: BUNDLE,
        slug: 'free-scan',
        siteHash: PAGE_HASH,
      }
      expect(insert?.[1]).toEqual([TENANT, BUNDLE, 'publish_page', JSON.stringify(expectedPayload), RECEIPT])
    } finally {
      unregister()
    }
  })

  it('refuses an approval whose page names an asset that has no bytes, and signs nothing', async () => {
    const artifacts = [
      { id: 'a1', kind: 'page_html', text_content: '<img src="{{ASSET:hero}}">' },
      { id: 'a2', kind: 'image', text_content: null, document_id: DOC, title: 'hero', mime: 'image/png' },
    ]
    const client = clientReturning(
      [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } } })],
      artifacts,
    )
    await expect(approve(client, PAGE_HASH)).rejects.toThrow(BundleNotApprovableError)
    const message = await approve(client, PAGE_HASH).catch((e: unknown) => String((e as Error).message))
    expect(message).toContain('asset_bytes_missing')
    expect(client.sqls().some((sql) => sql.includes('INSERT INTO marketing_actions'))).toBe(false)
  })

  it('hashes the picture into the approval rather than beside it', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01])
    const siteArtifacts = [
      { id: 'a1', kind: 'page_html', textContent: '<img src="{{ASSET:hero}}">' },
      { id: 'a2', kind: 'image', textContent: null, documentId: DOC, title: 'hero', mime: 'image/png', bytes: png },
    ]
    // The hash a stage would have recorded, computed by the resolver over the
    // picture as well as the page.
    const expected = siteHashOf(resolveSite('free-scan', siteArtifacts))
    const client = clientReturning(
      [bundleRow({ funnel_plan: { page: { slug: 'free-scan' } } })],
      [
        { id: 'a1', kind: 'page_html', text_content: '<img src="{{ASSET:hero}}">' },
        { id: 'a2', kind: 'image', text_content: null, document_id: DOC, title: 'hero', mime: 'image/png' },
      ],
      [{ document_id: DOC, data: png }],
    )
    // The proof is that the comparison passes: `expected` names the PNG's bytes, and
    // the code before this task resolved a text-only page and refused this hash.
    // The adapter scaffold is not part of the proof: without one the case would
    // refuse at `blockedActions` after the comparison, exactly like the sibling
    // 'approves when the bytes still hash' case above registers to avoid.
    const unregister = registerActionAdapter({
      name: 'publish_page',
      execute: () => Promise.resolve({ externalId: 'x' }),
    })
    try {
      await expect(approve(client, expected)).resolves.toBe(BUNDLE)
    } finally {
      unregister()
    }
  })
})

describe('slice 2 derivation', () => {
  const pageArtifact = (text: string) => ({ id: 'a1', kind: 'page_html', textContent: text })
  const bundleWithPage = { id: 'b1', funnelPlan: { page: { slug: 'physio' } }, mediaPlan: null }

  it('carries the bundle id and a hash of the bytes, never prose', () => {
    const [publish] = deriveActions(bundleWithPage, [pageArtifact('<h1>hi</h1>')])
    expect(publish?.action).toBe('publish_page')
    expect(Object.keys(publish?.payload ?? {}).sort()).toEqual(['bundleId', 'siteHash', 'slug'])
  })

  it('derives no publish when the bundle has no artifacts at all', () => {
    expect(deriveActions(bundleWithPage, [])).toEqual([])
  })

  it('publishes a thank-you page on its own, because the file set is what is approved', () => {
    // Surprising but not wrong: derivation publishes the files resolveSite
    // returns, and a thank_you_html is a file at <slug>/thanks/index.html. The
    // hash the reviewer approves covers exactly that file, so nothing
    // unapproved is published; there is simply no landing page at the slug.
    const thanks = [{ id: 'a1', kind: 'thank_you_html', textContent: '<p>thanks</p>' }]
    const [publish] = deriveActions(bundleWithPage, thanks)
    expect(publish?.action).toBe('publish_page')
    expect(publish?.payload).toEqual({
      bundleId: 'b1',
      slug: 'physio',
      siteHash: siteHashOf(resolveSite('physio', thanks)),
    })
  })

  it('answers the same siteHash for the same bytes', () => {
    const a = deriveActions(bundleWithPage, [pageArtifact('<h1>hi</h1>')])[0]
    const b = deriveActions(bundleWithPage, [pageArtifact('<h1>hi</h1>')])[0]
    expect(a?.payload.siteHash).toBe(b?.payload.siteHash)
  })

  it('refuses to derive a page from a slug the site cannot publish', () => {
    // The slug is a phrase an agent wrote. Task 3 decides what a publishable one
    // looks like; this asserts the decision reaches derivation rather than being
    // quoted in a comment.
    expect(() =>
      deriveActions(
        { ...bundleWithPage, funnelPlan: { page: { slug: 'Free Quote' } } },
        [pageArtifact('<h1>hi</h1>')],
      ),
    ).toThrow(SlugProblemError)
  })

  it('reports the slug it will publish', () => {
    expect(pageSlugOf(bundleWithPage)).toBe('physio')
    expect(pageSlugOf({ funnelPlan: { page: null } })).toBeNull()
  })

  it('refuses a slot holding two artifacts before it derives anything', () => {
    const problem = slotProblemCheck([pageArtifact('<h1>old</h1>'), { id: 'a2', kind: 'page_html', textContent: '<h1>new</h1>' }])
    expect(problem).toContain('page_html')
  })
})
