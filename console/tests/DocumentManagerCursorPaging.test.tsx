import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DocumentManager } from '../components/DocumentManager'
import { route, stubFetch, type FetchStub, type Reply } from './fetchStub'
import type { ReviewQueueResponse } from '../lib/review'

const DOC1 = 'a1a1a1a1-0000-4000-8000-000000000001'
const DOC2 = 'b2b2b2b2-0000-4000-8000-000000000002'

function queueItem(id: string, title: string, openErrors: number): ReviewQueueResponse['items'][number] {
  return {
    documentId: id,
    title,
    kind: 'invoice',
    status: 'needs_review',
    confidence: 0.9,
    lowestFieldConfidence: 0.8,
    openErrors,
    openWarnings: 0,
    reasons: ['open error'],
    createdAt: '2026-11-03 09:00:00+00',
  }
}

describe('ReviewQueueResponse cursor shape', () => {
  it('includes nextCursor and hasMore, not offset', () => {
    const response: ReviewQueueResponse = {
      items: [],
      total: 0,
      limit: 50,
      nextCursor: null,
      hasMore: false,
    }
    expect(response).toHaveProperty('nextCursor')
    expect(response).toHaveProperty('hasMore')
    expect(response).not.toHaveProperty('offset')
  })
})

describe('DocumentManager cursor paging', () => {
  const FIRST_PAGE: Reply = {
    status: 200,
    body: {
      total: 2,
      limit: 1,
      nextCursor: '1|0.8|2026-11-03T09:00:00.000Z|' + DOC1,
      hasMore: true,
      items: [queueItem(DOC1, 'Doc 1', 1)],
    } satisfies ReviewQueueResponse,
  }

  const SECOND_PAGE: Reply = {
    status: 200,
    body: {
      total: 2,
      limit: 1,
      nextCursor: null,
      hasMore: false,
      items: [queueItem(DOC2, 'Doc 2', 0)],
    } satisfies ReviewQueueResponse,
  }

  let server: FetchStub

  beforeEach(() => {
    server = stubFetch([
      route('/api/documents/review-queue', (call) => {
        if (call.url.includes('cursor=')) return SECOND_PAGE
        return FIRST_PAGE
      }, 'GET'),
      route('/api/documents?kind=invoice', { status: 200, body: { documents: [], total: 0 } }, 'GET'),
    ])
  })

  it('sends cursor from last page when Load more clicked', async () => {
    render(<DocumentManager kind="invoice" />)

    // Enter review mode
    await userEvent.click(screen.getByRole('button', { name: /needs review/i }))

    await waitFor(() => expect(server.count('review-queue')).toBe(1))
    await waitFor(() => expect(screen.getByText('Doc 1')).toBeTruthy())

    // Click Load more
    const loadMoreBtn = await screen.findByRole('button', { name: /load more/i })
    await userEvent.click(loadMoreBtn)

    await waitFor(() => expect(server.count('review-queue')).toBe(2))

    // Verify the second request included the cursor
    const secondCall = server.calls.find((c) => c.url.includes('cursor='))
    expect(secondCall).toBeTruthy()
    expect(secondCall?.url).toContain('cursor=')

    // Verify both items are now shown
    await waitFor(() => expect(screen.getByText('Doc 2')).toBeTruthy())
  })

  it('does not show Load more when hasMore is false', async () => {
    // Override to return a single page with hasMore=false
    server = stubFetch([
      route('/api/documents/review-queue', {
        status: 200,
        body: {
          total: 1,
          limit: 50,
          nextCursor: null,
          hasMore: false,
          items: [queueItem(DOC1, 'Only Doc', 1)],
        } satisfies ReviewQueueResponse,
      }, 'GET'),
      route('/api/documents?kind=invoice', { status: 200, body: { documents: [], total: 0 } }, 'GET'),
    ])

    render(<DocumentManager kind="invoice" />)
    await userEvent.click(screen.getByRole('button', { name: /needs review/i }))
    await waitFor(() => expect(screen.getByText('Only Doc')).toBeTruthy())

    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
  })

  it('resets cursor when leaving and re-entering review mode', async () => {
    render(<DocumentManager kind="invoice" />)

    // Enter review mode
    await userEvent.click(screen.getByRole('button', { name: /needs review/i }))
    await waitFor(() => expect(server.count('review-queue')).toBe(1))

    // Load more to get second page
    const loadMoreBtn = await screen.findByRole('button', { name: /load more/i })
    await userEvent.click(loadMoreBtn)
    await waitFor(() => expect(server.count('review-queue')).toBe(2))

    // Leave review mode
    await userEvent.click(await screen.findByRole('button', { name: /all invoices/i }))

    // Re-enter review mode - should start fresh (no cursor in URL)
    await userEvent.click(screen.getByRole('button', { name: /needs review/i }))
    await waitFor(() => expect(server.count('review-queue')).toBe(3))

    // The third call should NOT have a cursor parameter (reset)
    const thirdCall = server.calls.filter((c) => c.url.includes('review-queue'))[2]
    expect(thirdCall.url).not.toContain('cursor=')
  })
})
