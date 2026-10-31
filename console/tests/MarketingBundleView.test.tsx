import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MarketingBundleView } from '../components/MarketingBundleView'
import { route, stubFetch, type FetchStub, type Reply, type Rule } from './fetchStub'
import type { MarketingActionRecord, MarketingBundleResponse } from '../lib/types'

const BUNDLE_ID = '33333333-3333-4333-8333-333333333333'
const DOCUMENT_ID = '55555555-5555-4555-8555-555555555555'
const DRAFT_ID = 'd2d2d2d2-2222-4222-8222-222222222222'

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

  it('announces the loading state before any answer arrives', () => {
    // Sync body, no await: the fetch resolves on a later microtask, so the only
    // state this can observe is the loading branch. If a refactor dropped it, the
    // a11y node the brief asks for would vanish with no test noticing.
    server = stubFetch([route('/api/marketing/bundles/', ok(bundleResponse()))])
    render(<MarketingBundleView bundleId={BUNDLE_ID} />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading bundle')
    expect(screen.queryByText('Media plan')).toBeNull()
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
    payload: { bundleId: BUNDLE_ID, slug: 'physio-probe', siteHash: 'a'.repeat(64) },
    result: { url: 'https://dep-1.example.pages.dev', deploymentId: 'dep-1', uploadedAt: '2026-10-31T00:00:00Z' },
    createdAt: '2026-10-31T00:00:00Z',
    executedAt: '2026-10-31T00:00:00Z',
    ...over,
  }
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
    // The hash on screen is the one the approver clicked, taken from the action
    // payload, not recomputed by the browser.
    expect(screen.getByText('a'.repeat(12))).toBeInTheDocument()
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
    await userEvent.click(screen.getByRole('button', { name: /prepare go-live/i }))

    expect(await screen.findByText(/staged for approval/i)).toBeInTheDocument()
    expect(server.count('/promote')).toBe(1)
    expect(server.last('/promote')?.method).toBe('POST')
    // No body: the promotion takes the bundle id from the path and the ceiling
    // from the bundle that was already approved, so the console cannot offer a
    // number the owner did not approve.
    expect(server.last('/promote')?.body).toBeUndefined()
    // The one line that keeps the slice honest: a go-live click stages a
    // decision, it never makes one.
    expect(server.last('/approvals')?.method).not.toBe('POST')
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
})
