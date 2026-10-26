import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

/**
 * `/chats` is a read surface with three honest states (rows, nothing yet, the read
 * failed) and one debounced second read (search). Those are what this file proves.
 *
 * `next/link` is reduced to an anchor here for the same reason `shell.test.tsx`
 * does it: there is no App Router mounted in a bare `render()`, and the component
 * only ever needs `href` out of a link.
 *
 * The rename and delete *menu interactions* are not driven here. Radix's dropdown
 * opens on a pointer event that jsdom does not implement without a polyfill
 * harness; the mutations behind them are one `PATCH` and one `DELETE` on the same
 * `lib/api` client that `api.test.ts` covers at the request layer.
 */
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string
    children: ReactNode
    [key: string]: unknown
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

import { ConversationList } from '@/components/chats/ConversationList'
import { route, stubFetch, type FetchStub } from './fetchStub'
import type { ThreadRow } from '@/lib/types'

function row(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Quarterly pipeline review',
    created_at: '2026-10-20T09:00:00Z',
    updated_at: '2026-10-20T09:00:00Z',
    resource_id: null,
    ...over,
  }
}

let server: FetchStub
let client: QueryClient

function mount(children: ReactNode) {
  client = new QueryClient({
    // No retries: a failing read should surface as the component's error state on
    // the first attempt, not disappear into a default three-strike retry.
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  })
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
}

beforeEach(() => {
  server = stubFetch([])
})

afterEach(() => {
  client?.clear()
  vi.unstubAllGlobals()
})

describe('ConversationList', () => {
  it('renders the caller’s conversations as links into each thread', async () => {
    server = stubFetch([
      route('/api/agent/threads', {
        status: 200,
        body: {
          sessions: [row(), row({ id: '33333333-3333-4333-8333-333333333333', title: null })],
          total: 2,
        },
      }),
    ])
    mount(<ConversationList />)

    const link = await screen.findByRole('link', { name: /Quarterly pipeline review/ })
    expect(link).toHaveAttribute('href', '/chats/11111111-1111-4111-8111-111111111111')
    expect(link.textContent).toContain('Active')
    // A row with no title is named, not left blank: an empty row is unclickable in
    // practice even when it links somewhere real.
    expect(screen.getByRole('link', { name: /Untitled conversation/ })).toHaveAttribute(
      'href',
      '/chats/33333333-3333-4333-8333-333333333333',
    )
  })

  it('shows a distinct empty state that leads to the launch view', async () => {
    server = stubFetch([route('/api/agent/threads', { status: 200, body: { sessions: [], total: 0 } })])
    mount(<ConversationList />)

    expect(await screen.findByText('No conversations yet.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'New chat' })).toHaveAttribute('href', '/chats/new')
  })

  it('reports a failed read with the reason and a retry that reads again', async () => {
    server = stubFetch([
      route('/api/agent/threads', {
        status: 503,
        body: { error: 'unavailable', detail: 'gateway down' },
      }),
    ])
    mount(<ConversationList />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('gateway down')

    const before = server.count('/api/agent/threads')
    fireEvent.click(screen.getByLabelText('Retry loading conversations'))
    await waitFor(() => expect(server.count('/api/agent/threads')).toBeGreaterThan(before))
  })

  it('replaces the history with semantic search results once a query settles', async () => {
    server = stubFetch([
      route('/api/agent/threads', { status: 200, body: { sessions: [row()], total: 1 } }),
      route('/api/agent/search', {
        status: 200,
        body: {
          hits: [
            {
              thread_id: '44444444-4444-4444-8444-444444444444',
              snippet: 'Nordwind asked for pricing next week.',
              score: 0.81,
              created_at: '2026-10-21T10:00:00Z',
            },
          ],
        },
      }),
    ])
    mount(<ConversationList />)

    await screen.findByRole('link', { name: /Quarterly pipeline review/ })
    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'nordwind' } })

    // 300ms debounce, so the search read is not fired per keystroke.
    const results = await screen.findByRole('list', { name: 'Search results' }, { timeout: 2000 })
    expect(results.textContent).toContain('Nordwind asked for pricing next week.')
    expect(server.last('/api/agent/search')?.url).toContain('query=nordwind')
    // The history list is not live underneath the results: one read at a time.
    expect(screen.queryByRole('link', { name: /Quarterly pipeline review/ })).toBeNull()
  })

  it('says nothing matched instead of showing the unfiltered list', async () => {
    server = stubFetch([
      route('/api/agent/threads', { status: 200, body: { sessions: [row()], total: 1 } }),
      route('/api/agent/search', { status: 200, body: { hits: [] } }),
    ])
    mount(<ConversationList />)

    await screen.findByRole('link', { name: /Quarterly pipeline review/ })
    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'zzzz' } })

    expect(await screen.findByText(/No conversations match/, undefined, { timeout: 2000 })).toBeInTheDocument()
  })
})
