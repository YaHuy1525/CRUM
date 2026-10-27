import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

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

import HomePage from '@/app/page'
import { AwaitingDecisionCard } from '@/components/home/AwaitingDecisionCard'
import { QuickLauncher } from '@/components/home/QuickLauncher'
import { RecentConversationsCard } from '@/components/home/RecentConversationsCard'
import { TodayCard } from '@/components/home/TodayCard'
import type { DigestResponse, QueueItem, ThreadRow } from '@/lib/types'
import { route, stubFetch, type FetchStub } from './fetchStub'

const DRAFT_ID = 'd1d1d1d1-1111-4111-8111-111111111111'

function draft(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: DRAFT_ID,
    object_type: 'customer',
    operation: 'create',
    target_id: null,
    payload: { name: 'Nordwind Freight' },
    risk_score: 72,
    gate: 'approval',
    action_hash: 'hash',
    run_id: 'run-1',
    thread_id: null,
    requested_by: 'user-1',
    created_at: '2026-10-25T09:00:00.000Z',
    expires_at: '2026-11-01T09:00:00.000Z',
    receipt_id: null,
    rejected_at: null,
    committed_at: null,
    committed_record_id: null,
    suspension: null,
    ...over,
  }
}

function thread(over: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Quarterly pipeline review',
    created_at: '2026-10-20T09:00:00Z',
    updated_at: '2026-10-20T09:00:00Z',
    resource_id: null,
    ...over,
  }
}

function digest(over: Partial<DigestResponse> = {}): DigestResponse {
  return {
    date: '2026-10-26',
    overdue: [{ id: 't1', customer_id: null, label: 'Call Nordwind' }],
    todaySchedule: [],
    staleFollowups: [],
    summary: 'One task is overdue.',
    ...over,
  }
}

let server: FetchStub
let client: QueryClient

function mount(children: ReactNode) {
  client = new QueryClient({
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

describe('AwaitingDecisionCard', () => {
  it('reads the pending queue and points at governance', async () => {
    server = stubFetch([
      route('/api/approvals/pending', { status: 200, body: { items: [draft()], total: 1 } }),
    ])
    mount(<AwaitingDecisionCard />)

    const card = screen.getByRole('region', { name: 'Awaiting decision' })
    expect(await screen.findByText('draft awaiting a decision')).toBeInTheDocument()
    expect(card.textContent).toContain('customer · create')
    expect(screen.getByRole('link', { name: 'Open governance' })).toHaveAttribute(
      'href',
      '/governance',
    )
    expect(server.calls.map((c) => c.url)).toEqual(['/api/approvals/pending'])
  })

  it('says the queue is empty instead of leaving a hole', async () => {
    server = stubFetch([route('/api/approvals/pending', { status: 200, body: { items: [], total: 0 } })])
    mount(<AwaitingDecisionCard />)

    expect(await screen.findByText(/Nothing is waiting on you/)).toBeInTheDocument()
  })

  it('reports a failed read and reads again on retry', async () => {
    server = stubFetch([
      route('/api/approvals/pending', { status: 401, body: { error: 'unauthorized', reason: 'missing-claim' } }),
    ])
    mount(<AwaitingDecisionCard />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('missing-claim')

    const before = server.count('/api/approvals/pending')
    fireEvent.click(screen.getByLabelText('Retry loading the approval queue'))
    await waitFor(() => expect(server.count('/api/approvals/pending')).toBeGreaterThan(before))
  })
})

describe('TodayCard', () => {
  it('counts the digest and links each count into Records', async () => {
    server = stubFetch([
      route('/api/digest', {
        status: 200,
        body: digest({ todaySchedule: [{ id: 's1', customer_id: null, label: 'Nordwind call' }] }),
      }),
    ])
    mount(<TodayCard />)

    const card = screen.getByRole('region', { name: 'Today' })
    expect(await screen.findByText('Overdue tasks')).toBeInTheDocument()
    expect(card.textContent).toContain('One task is overdue.')
    expect(screen.getByRole('link', { name: /Overdue tasks/ })).toHaveAttribute(
      'href',
      '/records?object=tasks',
    )
    expect(screen.getByRole('link', { name: /Scheduled today/ })).toHaveAttribute(
      'href',
      '/records?object=schedules',
    )
    expect(server.last('/api/digest')?.url).toMatch(/date=\d{4}-\d{2}-\d{2}/)
  })

  it('says all clear when nothing is pending', async () => {
    server = stubFetch([
      route('/api/digest', {
        status: 200,
        body: digest({ overdue: [], todaySchedule: [], staleFollowups: [], summary: '' }),
      }),
    ])
    mount(<TodayCard />)

    expect(await screen.findByText(/Nothing pending\. All clear for 2026-10-26/)).toBeInTheDocument()
  })
})

describe('RecentConversationsCard', () => {
  it('lists conversations and names an untitled one', async () => {
    server = stubFetch([
      route('/api/agent/threads', {
        status: 200,
        body: {
          sessions: [thread(), thread({ id: '33333333-3333-4333-8333-333333333333', title: null })],
          total: 2,
        },
      }),
    ])
    mount(<RecentConversationsCard />)

    expect(
      await screen.findByRole('link', { name: /Quarterly pipeline review/ }),
    ).toHaveAttribute('href', '/chats/22222222-2222-4222-8222-222222222222')
    expect(
      screen.getByRole('link', { name: /Untitled conversation/ }),
    ).toHaveAttribute('href', '/chats/33333333-3333-4333-8333-333333333333')
    expect(screen.getByRole('link', { name: 'All conversations' })).toHaveAttribute('href', '/chats')
  })

  it('offers a first conversation when there are none', async () => {
    server = stubFetch([route('/api/agent/threads', { status: 200, body: { sessions: [], total: 0 } })])
    mount(<RecentConversationsCard />)

    expect(await screen.findByText(/No conversations yet/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Start one' })).toHaveAttribute('href', '/chats/new')
  })
})

describe('QuickLauncher', () => {
  it('offers the four routes the spec names', () => {
    mount(<QuickLauncher />)

    const nav = screen.getByRole('navigation', { name: 'Quick actions' })
    const hrefs = Array.from(nav.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(['/chats/new', '/records/new', '/knowledge', '/usage'])
  })
})

describe('HomePage', () => {
  it('composes the three cards and the launcher, each reading its own endpoint', async () => {
    server = stubFetch([
      route('/api/approvals/pending', { status: 200, body: { items: [], total: 0 } }),
      route('/api/digest', { status: 200, body: digest() }),
      route('/api/agent/threads', { status: 200, body: { sessions: [thread()], total: 1 } }),
    ])
    mount(<HomePage />)

    expect(screen.getByRole('heading', { name: 'Welcome back.' })).toBeInTheDocument()
    expect(await screen.findByRole('region', { name: 'Awaiting decision' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Today' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Recent conversations' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Quick actions' })).toBeInTheDocument()

    await waitFor(() => {
      expect(server.count('/api/approvals/pending')).toBe(1)
      expect(server.count('/api/digest')).toBe(1)
      expect(server.count('/api/agent/threads')).toBe(1)
    })

    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull()
  })
})
