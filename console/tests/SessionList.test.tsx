import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SessionList } from '../components/SessionList'

/**
 * `fetch` is stubbed, and the stub is called with the relative path the component
 * asked for. Node's `fetch` (which is what jsdom hands out) rejects a relative URL
 * outright — "Failed to parse URL" — so a test that forgot to stub it would fail
 * for an environmental reason rather than a real one. Browsers resolve these paths
 * against :3000, which is the whole point of the rewrite setup.
 */
const fetchMock = vi.fn()

function ok(body: unknown) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
}

function fail(status: number, body: unknown) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }))
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const THREADS = [
  {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Nordwind renewal',
    created_at: '2026-10-24T09:00:00.000Z',
    updated_at: '2026-10-24T09:30:00.000Z',
    resource_id: 'tenant-1:user-1',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    title: null,
    created_at: '2026-10-23T09:00:00.000Z',
    updated_at: '2026-10-25T09:00:00.000Z',
    resource_id: 'tenant-1:user-1',
  },
]

describe('SessionList', () => {
  it('reads threads from the plane rather than rendering a mock array', async () => {
    ok({ sessions: THREADS, total: 2 })
    render(<SessionList />)

    await screen.findByText('Nordwind renewal')
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/threads', expect.anything())
  })

  it('shows the id when a thread has no title, newest activity first', async () => {
    ok({ sessions: THREADS, total: 2 })
    const { container } = render(<SessionList />)
    await screen.findByText('Nordwind renewal')

    // The untitled one is the most recently updated, so it leads.
    const titles = Array.from(container.querySelectorAll('.session-title')).map((n) => n.textContent)
    expect(titles[0]).toBe(THREADS[1].id)
    expect(titles[1]).toBe('Nordwind renewal')
  })

  it('distinguishes "no conversations" from "could not read them"', async () => {
    ok({ sessions: [], total: 0 })
    const empty = render(<SessionList />)
    expect(await screen.findByText(/No conversations yet/)).toBeInTheDocument()

    // Same component, different fact: an empty list must not be what a 401 looks
    // like, or a misconfigured console reads as an empty tenant.
    fail(401, { error: 'unauthorized', reason: 'invalid-claim' })
    const failed = render(<SessionList />)
    await waitFor(() => expect(failed.getByRole('alert').textContent).toContain('invalid-claim'))
    // Scoped to this render's container on purpose. Both the queries `render`
    // returns and `screen` are bound to document.body, which still holds the
    // empty list above — checking that one would prove nothing about this one.
    expect(failed.container.querySelector('.empty-state')).toBeNull()
    expect(empty.container.querySelector('.empty-state')).not.toBeNull()
  })

  it('reports an unreachable plane with the port that is down', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    render(<SessionList />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(':4113')
  })

  it('tells the parent which conversation was picked', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    ok({ sessions: THREADS, total: 2 })
    render(<SessionList onSelect={onSelect} />)

    await user.click(await screen.findByText('Nordwind renewal'))
    expect(onSelect).toHaveBeenCalledWith(THREADS[0].id)
  })

  it('marks the active conversation for a screen reader', async () => {
    ok({ sessions: THREADS, total: 2 })
    render(<SessionList activeThreadId={THREADS[0].id} />)

    const row = await screen.findByRole('option', { name: /Nordwind renewal/ })
    expect(row).toHaveAttribute('aria-selected', 'true')
    expect(row.className).toContain('active')
  })

  it('renders without provisioning anything but one GET', async () => {
    ok({ sessions: THREADS, total: 2 })
    const start = performance.now()
    render(<SessionList />)
    await screen.findByText('Nordwind renewal')
    const elapsed = performance.now() - start

    // §16 Phase 1 acceptance: the session list renders under 300ms and touches no
    // workspace, model or run — one read is the entire footprint.
    expect(elapsed).toBeLessThan(300)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![1] as { method?: string }).toEqual(expect.objectContaining({ method: 'GET' }))
  })
})
