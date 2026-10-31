import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MarketingBundleView } from '../components/MarketingBundleView'
import { route, stubFetch, type FetchStub, type Reply, type Rule } from './fetchStub'
import type { MarketingActionRecord, MarketingBundleResponse } from '../lib/types'

const BUNDLE_ID = '33333333-3333-4333-8333-333333333333'
const DOCUMENT_ID = '55555555-5555-4555-8555-555555555555'
const DRAFT_ID = 'd2d2d2d2-2222-4222-8222-222222222222'
const SITE_HASH = 'a'.repeat(64)
const PAGE_CONTENT = '<h1>Book your assessment</h1>'
const THANK_YOU_CONTENT = '<h1>Thanks, we will call you</h1>'

function bundleResponse(over: Partial<MarketingBundleResponse> = {}): MarketingBundleResponse {
  return {
    bundle: {
      id: BUNDLE_ID,
      tenantId: '11111111-1111-4111-8111-111111111111',
      brief: 'Book more physio assessments in Melbourne',
      objective: 'outreach_support',
      audienceNote: 'owner-led clinics with 2 to 8 staff',
      status: 'staged',
      strategy: { position: 'the clinic that answers within an hour' },
      copy: { hooks: ['Your next patient is already searching'] },
      mediaPlan: null,
      funnelPlan: null,
      analysis: null,
      promptVersion: 'marketing-v1',
      draftHash: 'b'.repeat(64),
      leadToken: null,
      createdAt: '2026-10-30T02:00:00.000Z',
      updatedAt: '2026-10-30T02:05:00.000Z',
    },
    artifacts: [
      {
        id: 'a1',
        role: 'marketer-copywriter',
        kind: 'script',
        documentId: null,
        textContent: 'Objection handling: price is a comparison, not a no.',
        status: 'pending_review',
        createdAt: '2026-10-30T02:00:00.000Z',
      },
    ],
    actions: [],
    ...over,
  }
}

const ok = (body: MarketingBundleResponse): Reply => ({ status: 200, body })

let server: FetchStub

function mount(rules: Rule[]) {
  server = stubFetch(rules)
  return render(<MarketingBundleView bundleId={BUNDLE_ID} />)
}

beforeEach(() => {
  server = stubFetch([])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MarketingBundleView', () => {
  it('reads the bundle and shows the prose a reviewer is approving', async () => {
    mount([route('/api/marketing/bundles/', ok(bundleResponse()))])

    expect(await screen.findByText('Book more physio assessments in Melbourne')).toBeInTheDocument()
    expect(screen.getByText('Your next patient is already searching')).toBeInTheDocument()
    expect(screen.getByText('the clinic that answers within an hour')).toBeInTheDocument()
    expect(screen.getByText(/Objection handling/)).toBeInTheDocument()
    expect(server.last('/api/marketing/bundles/')?.url).toBe(`/api/marketing/bundles/${BUNDLE_ID}`)
  })

  it('labels the objective and the status, because those are the two words that decide a review', async () => {
    mount([route('/api/marketing/bundles/', ok(bundleResponse()))])
    // A regex, not an exact string: PageHeader renders the objective label and the
    // audience note as two sibling text nodes inside one <p>
    // (console/components/PageHeader.tsx:28), and testing-library joins an element's
    // direct text children before matching, so 'Support outreach' can never match the
    // run it is part of. The console suite already reaches for regexes here for exactly
    // this reason (console/tests/ApprovalQueue.test.tsx:81,83).
    expect(await screen.findByText(/Support outreach/)).toBeInTheDocument()
    expect(screen.getByText('staged')).toBeInTheDocument()
  })

  it('names every role that produced an asset', async () => {
    mount([route('/api/marketing/bundles/', ok(bundleResponse()))])
    expect(await screen.findByText(/marketer-copywriter/)).toBeInTheDocument()
    expect(screen.getByText(/script/)).toBeInTheDocument()
  })

  it('links an image artifact to its document instead of pretending to render it', async () => {
    const withImage = bundleResponse({
      artifacts: [
        {
          id: 'a2',
          role: 'creative-designer',
          kind: 'image',
          documentId: DOCUMENT_ID,
          textContent: null,
          status: 'pending_review',
          createdAt: '2026-10-30T02:00:00.000Z',
        },
      ],
    })
    mount([route('/api/marketing/bundles/', ok(withImage))])

    const link = await screen.findByRole('link', { name: DOCUMENT_ID.slice(0, 8) })
    expect(link).toHaveAttribute('href', `/api/documents/${DOCUMENT_ID}`)
    expect(screen.getByText(/renders no image/)).toBeInTheDocument()
  })

  it('says nothing recorded for the blocks a bundle does not carry', async () => {
    mount([route('/api/marketing/bundles/', ok(bundleResponse()))])
    expect(await screen.findByText('Media plan')).toBeInTheDocument()
    expect(screen.getAllByText('Nothing recorded.').length).toBeGreaterThanOrEqual(3)
  })

  it('a missing bundle is a plain not found, never an empty one', async () => {
    mount([route('/api/marketing/bundles/', { status: 404, body: { error: 'not_found' } })])
    expect(await screen.findByText('Bundle not found.')).toBeInTheDocument()
    expect(screen.queryByText('Media plan')).toBeNull()
  })

  it('an unreadable bundle is reported as a failure, not as an absent one', async () => {
    mount([
      route('/api/marketing/bundles/', {
        status: 401,
        body: { error: 'unauthorized', reason: 'missing-claim' },
      }),
    ])
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('missing-claim')
    expect(screen.queryByText('Bundle not found.')).toBeNull()
  })

  it('Retry re-reads after a failure', async () => {
    const user = userEvent.setup()
    let first = true
    mount([
      route('/api/marketing/bundles/', () => {
        const reply = first
          ? { status: 500, body: { error: 'db_down' } }
          : ok(bundleResponse())
        first = false
        return reply
      }),
    ])

    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Book more physio assessments in Melbourne')).toBeInTheDocument()
    expect(server.count('/api/marketing/bundles/')).toBe(2)
  })

  it('a 200 whose envelope has no bundle is an error, not a blank screen', async () => {
    // The shape the console type says is impossible, which is the point: the type
    // lives in console/lib/types.ts and is not checked against src/ at build time.
    mount([
      route('/api/marketing/bundles/', {
        status: 200,
        body: { artifacts: [] } as unknown as MarketingBundleResponse,
      }),
    ])
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('without a bundle')
    expect(screen.queryByText('Media plan')).toBeNull()
  })

  it('announces the loading state before any answer arrives', async () => {
    // The body runs synchronously up to the first await: the fetch resolves on a
    // later microtask, so the only state the first assertions can observe is the
    // loading branch. If a refactor dropped it, the a11y node the brief asks for
    // would vanish with no test noticing.
    server = stubFetch([route('/api/marketing/bundles/', ok(bundleResponse()))])
    render(<MarketingBundleView bundleId={BUNDLE_ID} />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading bundle')
    expect(screen.queryByText('Media plan')).toBeNull()
    // Then let the answer land inside act, the way the rest of this file does.
    // The file hashes are awaited after the fetch, so a test that ends while
    // they are still queued updates the component after the test, which React
    // reports as an update not wrapped in act.
    expect(await screen.findByText('Book more physio assessments in Melbourne')).toBeInTheDocument()
  })
})

function published(over: Partial<MarketingActionRecord> = {}): MarketingActionRecord {
  return {
    id: 'act1',
    action: 'publish_page',
    status: 'succeeded',
    attempts: 1,
    externalId: 'dep-1',
    lastError: null,
    payload: { bundleId: BUNDLE_ID, slug: 'physio-probe', siteHash: SITE_HASH },
    result: { url: 'https://dep-1.example.pages.dev', deploymentId: 'dep-1', uploadedAt: '2026-10-31T00:00:00Z' },
    createdAt: '2026-10-31T00:00:00Z',
    executedAt: '2026-10-31T00:00:00Z',
    ...over,
  }
}

function failedPublish(over: Partial<MarketingActionRecord> = {}): MarketingActionRecord {
  return published({
    status: 'failed',
    externalId: null,
    result: null,
    lastError: 'pages_upload_http_403: authentication error',
    ...over,
  })
}

function promoted(over: Partial<MarketingActionRecord> = {}): MarketingActionRecord {
  return published({
    action: 'promote_page',
    externalId: 'dep-2',
    result: {
      url: 'https://dep-2.example.pages.dev',
      deploymentId: 'dep-2',
      uploadedAt: '2026-10-31T01:00:00Z',
    },
    createdAt: '2026-10-31T01:00:00Z',
    executedAt: '2026-10-31T01:00:00Z',
    ...over,
  })
}

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

// The two slots the publisher places, both present, so a per-row hash has
// something to differ from and the site hash has a row to leak into.
function twoFileBundle(actions: MarketingActionRecord[]): MarketingBundleResponse {
  return bundleResponse({
    bundle: { ...bundleResponse().bundle, status: 'approved', leadToken: 'lt_probe' },
    artifacts: [
      {
        ...bundleResponse().artifacts[0]!,
        id: 'page',
        kind: 'page_html',
        role: 'funnel-builder',
        textContent: PAGE_CONTENT,
      },
      {
        ...bundleResponse().artifacts[0]!,
        id: 'thanks',
        kind: 'thank_you_html',
        role: 'funnel-builder',
        textContent: THANK_YOU_CONTENT,
      },
    ],
    actions,
  })
}

describe('MarketingBundleView go-live controls', () => {
  it('shows the preview url and the approved hash only after a publish succeeded', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          bundleResponse({
            bundle: { ...bundleResponse().bundle, status: 'approved', objective: 'inbound_leads', leadToken: 'lt_probe' },
            artifacts: [
              { ...bundleResponse().artifacts[0]!, kind: 'page_html', role: 'funnel-builder', textContent: '<h1>Book your assessment</h1>' },
            ],
            actions: [published()],
          }),
        ),
        'GET',
      ),
    ])

    expect(await screen.findByText('physio-probe/index.html')).toBeInTheDocument()
    // The site hash is the one the approver clicked, taken from the action
    // payload, not recomputed by the browser. It is shown once and labelled as
    // the site hash, never as a file's digest.
    expect(screen.getByText(SITE_HASH)).toBeInTheDocument()
    expect(screen.getByText(/site hash the approval signed/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /preview/i })).toHaveAttribute(
      'href',
      'https://dep-1.example.pages.dev',
    )
    expect(screen.getByRole('button', { name: /prepare go-live/i })).toBeEnabled()
  })

  it('explains a failed publish and offers the retry, not a reroll', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          bundleResponse({
            bundle: { ...bundleResponse().bundle, status: 'approved', leadToken: 'lt_probe' },
            artifacts: [
              { ...bundleResponse().artifacts[0]!, kind: 'page_html', role: 'funnel-builder', textContent: '<h1>Book your assessment</h1>' },
            ],
            actions: [
              published({ status: 'failed', externalId: null, result: null, attempts: 1,
                lastError: 'pages_upload_http_403: authentication error' }),
            ],
          }),
        ),
        'GET',
      ),
    ])

    expect(await screen.findByText(/pages_upload_http_403/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry publish/i })).toBeEnabled()
    // The control is named for the action it clones, so a failed publish is
    // never offered as the go-live door.
    expect(screen.queryByRole('button', { name: /retry go-live/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /prepare go-live/i })).toBeNull()
  })

  it('names the retry for a failed promotion as the go-live door', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          twoFileBundle([
            published(),
            promoted({
              id: 'act2',
              status: 'failed',
              externalId: null,
              result: null,
              lastError: 'custom_domain_http_409: zone already claimed',
            }),
          ]),
        ),
        'GET',
      ),
    ])

    expect(await screen.findByText(/custom_domain_http_409/)).toBeInTheDocument()
    // A failed promotion is the only remaining way onto the domain, so the
    // retry says so. "Retry publish" would name the action that already worked.
    expect(screen.getByRole('button', { name: /retry go-live/i })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /retry publish/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /prepare go-live/i })).toBeNull()
  })

  it('posts to the staging route and never to a decision endpoint', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          bundleResponse({
            bundle: { ...bundleResponse().bundle, status: 'approved', leadToken: 'lt_probe' },
            artifacts: [
              { ...bundleResponse().artifacts[0]!, kind: 'page_html', role: 'funnel-builder', textContent: '<h1>Book your assessment</h1>' },
            ],
            actions: [published()],
          }),
        ),
        'GET',
      ),
      route('/promote', { status: 201, body: { pendingWriteId: DRAFT_ID, riskScore: 10, gate: 'approval' } }, 'POST'),
    ])

    await screen.findByRole('button', { name: /prepare go-live/i })
    // Mount reads and never writes. Counting POSTs, rather than looking for a
    // decision route nothing in this scenario calls, is what makes the assertion
    // able to fail: any POST before the click belongs to the screen, not the owner.
    expect(server.calls.filter((call) => call.method === 'POST')).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: /prepare go-live/i }))

    expect(await screen.findByText(/staged for approval/i)).toBeInTheDocument()
    expect(server.count('/promote')).toBe(1)
    expect(server.last('/promote')?.method).toBe('POST')
    // No body: the promotion takes the bundle id from the path and the ceiling
    // from the bundle that was already approved, so the console cannot offer a
    // number the owner did not approve.
    expect(server.last('/promote')?.body).toBeUndefined()
    // The one line that keeps the slice honest: a go-live click stages a
    // decision, it never makes one. The only POST the whole test made is the
    // staging route, so nothing reached an approval or a decision endpoint.
    const posts = server.calls.filter((call) => call.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.url).toContain('/promote')
    expect(screen.getByRole('link', { name: /queue/i })).toHaveAttribute('href', '/approvals')
  })

  it('hides the promote control once the bundle is live', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          bundleResponse({
            bundle: { ...bundleResponse().bundle, status: 'live', leadToken: 'lt_probe' },
            artifacts: [
              { ...bundleResponse().artifacts[0]!, kind: 'page_html', role: 'funnel-builder', textContent: '<h1>Book your assessment</h1>' },
            ],
            actions: [
              published(),
              published({ id: 'act2', action: 'promote_page', externalId: 'dep-2',
                result: { url: 'https://example.pages.dev', deploymentId: 'dep-2', uploadedAt: '2026-10-31T01:00:00Z' } }),
            ],
          }),
        ),
        'GET',
      ),
    ])

    expect(await screen.findByRole('link', { name: /live site/i })).toHaveAttribute(
      'href',
      'https://example.pages.dev',
    )
    expect(screen.getByText('live')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /prepare go-live/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /retry publish/i })).toBeNull()
  })

  it('links the newest promotion when a bundle went live twice', async () => {
    const { container } = mount([
      route(
        '/api/marketing/bundles/',
        ok(
          twoFileBundle([
            published(),
            promoted({ id: 'promo1' }),
            promoted({
              id: 'promo2',
              externalId: 'dep-3',
              result: {
                url: 'https://dep-3.example.pages.dev',
                deploymentId: 'dep-3',
                uploadedAt: '2026-10-31T02:00:00Z',
              },
              createdAt: '2026-10-31T02:00:00Z',
              executedAt: '2026-10-31T02:00:00Z',
            }),
          ]),
        ),
        'GET',
      ),
    ])

    // Actions arrive oldest first, and the later promotion is the one that moved
    // the page to its domain. Linking the first deployment would point an owner
    // at a URL that stopped being the live site.
    expect(await screen.findByRole('link', { name: /live site/i })).toHaveAttribute(
      'href',
      'https://dep-3.example.pages.dev',
    )
    expect(container.querySelector('a[href="https://dep-2.example.pages.dev"]')).toBeNull()
  })

  it('hides the promote control while a promotion is already queued', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          twoFileBundle([
            published(),
            promoted({ id: 'promo1', status: 'queued', externalId: null, result: null }),
          ]),
        ),
        'GET',
      ),
    ])

    expect(await screen.findByText('physio-probe/index.html')).toBeInTheDocument()
    // The queued promotion is already a pending decision. A second control would
    // queue a duplicate the owner has to go and reject.
    expect(screen.queryByRole('button', { name: /prepare go-live/i })).toBeNull()
  })
})

describe('MarketingBundleView file hashes', () => {
  it("hashes each file from its own content, so a row matches the file's bytes", async () => {
    mount([route('/api/marketing/bundles/', ok(twoFileBundle([published()])), 'GET')])

    expect(await screen.findByText('physio-probe/index.html')).toBeInTheDocument()
    expect(screen.getByText('physio-probe/thanks/index.html')).toBeInTheDocument()
    // The expected digests come from Node, so these are known sha256 values
    // rather than a second reading of the component's own arithmetic.
    expect(screen.getByText(digestOf(PAGE_CONTENT).slice(0, 12))).toBeInTheDocument()
    expect(screen.getByText(digestOf(THANK_YOU_CONTENT).slice(0, 12))).toBeInTheDocument()
  })

  it('shows the approved site hash once above the table, never as a file digest', async () => {
    mount([route('/api/marketing/bundles/', ok(twoFileBundle([published()])), 'GET')])

    expect(await screen.findByText('physio-probe/index.html')).toBeInTheDocument()
    expect(screen.getAllByText(SITE_HASH)).toHaveLength(1)
    // The old table repeated the truncated aggregate in every row.
    expect(screen.queryAllByText(SITE_HASH.slice(0, 12))).toHaveLength(0)
  })

  it('shows a dash when this browser cannot hash, never an empty cell', async () => {
    vi.stubGlobal('crypto', {})
    mount([route('/api/marketing/bundles/', ok(twoFileBundle([published()])), 'GET')])

    expect(await screen.findByText('physio-probe/index.html')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(2)
  })
})

describe('MarketingBundleView retry staleness', () => {
  it('offers the retry when the newest attempt of an action failed', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          twoFileBundle([
            failedPublish({ id: 'act1', lastError: 'older failure' }),
            failedPublish({ id: 'act2', lastError: 'newest failure' }),
          ]),
        ),
        'GET',
      ),
    ])

    expect(await screen.findByText(/newest failure/)).toBeInTheDocument()
    expect(screen.queryByText(/older failure/)).toBeNull()
    expect(screen.getByRole('button', { name: /retry publish/i })).toBeEnabled()
  })

  it('hides the retry once a newer attempt of the same action is queued', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          twoFileBundle([
            failedPublish({ id: 'act1' }),
            published({ id: 'act2', status: 'queued', externalId: null, result: null }),
          ]),
        ),
        'GET',
      ),
    ])

    expect(await screen.findByText('physio-probe/index.html')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry publish/i })).toBeNull()
    // The failed row deliberately stays in the trail, but its error is no longer
    // the state of the action, so the screen does not report it as the last word.
    expect(screen.queryByText(/pages_upload_http_403/)).toBeNull()
  })

  it('hides the retry while the newest attempt of its action is running', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          twoFileBundle([
            failedPublish({ id: 'act1' }),
            published({ id: 'act2', status: 'running', externalId: null, result: null }),
          ]),
        ),
        'GET',
      ),
    ])

    expect(await screen.findByText('physio-probe/index.html')).toBeInTheDocument()
    // A running attempt is the action's current state, so the failure behind it
    // is superseded. Offering a retry beside a live attempt would queue a clone
    // of something that is already under way.
    expect(screen.queryByRole('button', { name: /retry publish/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /retry go-live/i })).toBeNull()
    expect(screen.queryByText(/pages_upload_http_403/)).toBeNull()
  })

  it('hides the retry once a newer attempt of the same action succeeded', async () => {
    mount([
      route(
        '/api/marketing/bundles/',
        ok(
          twoFileBundle([
            failedPublish({ id: 'act1' }),
            published({ id: 'act2', status: 'succeeded' }),
          ]),
        ),
        'GET',
      ),
    ])

    expect(await screen.findByText('physio-probe/index.html')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /retry publish/i })).toBeNull()
    expect(screen.queryByText(/pages_upload_http_403/)).toBeNull()
  })
})
