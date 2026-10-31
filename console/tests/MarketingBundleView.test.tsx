import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MarketingBundleView } from '../components/MarketingBundleView'
import { route, stubFetch, type FetchStub, type Reply, type Rule } from './fetchStub'
import type { MarketingBundleResponse } from '../lib/types'

const BUNDLE_ID = '33333333-3333-4333-8333-333333333333'
const DOCUMENT_ID = '55555555-5555-4555-8555-555555555555'

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
        status: 'ready',
        createdAt: '2026-10-30T02:00:00.000Z',
      },
    ],
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
          status: 'ready',
          createdAt: '2026-10-30T02:00:00.000Z',
        },
      ],
    })
    mount([route('/api/marketing/bundles/', ok(withImage))])

    const link = await screen.findByRole('link', { name: DOCUMENT_ID.slice(0, 8) })
    expect(link).toHaveAttribute('href', `/api/documents/${DOCUMENT_ID}`)
    expect(screen.getByText(/no renderer for generated images/)).toBeInTheDocument()
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
})
