import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { UsageDashboard } from '../components/UsageDashboard'
import { route, stubFetch, type FetchStub } from './fetchStub'


const METRICS = {
  tokensIn: 1_234,
  tokensOut: 5_678,
  cost: 3.456,
  cacheReadTokens: 300,
  cacheWriteTokens: 100,
  toolCallCount: 50,
  toolCallErrors: 5,
}

const METRICS_UNAVAILABLE = {
  status: 503,
  body: { error: 'Metrics not available — is PostgresStoreVNext configured?' },
}

let client: QueryClient

function renderUsage(children: ReactNode) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  })
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
}

let server: FetchStub

beforeEach(() => {
  server = stubFetch([])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UsageDashboard reading state', () => {
  it('names every card while the numbers are still unknown', async () => {
    let release: (body: unknown) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            release = (body) =>
              resolve(new Response(JSON.stringify(body), { status: 200 }))
          }),
      ),
    )

    renderUsage(<UsageDashboard />)
    expect(screen.getByRole('status')).toHaveTextContent('Reading usage metrics')
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
    for (const label of [
      'Tokens In',
      'Tokens Out',
      'Cost',
      'Cache Hit Rate',
      'Tool Calls',
      'Tool Error Rate',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.queryByText('1.2k')).toBeNull()

    release(METRICS)
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(document.querySelector('[aria-busy="true"]')).toBeNull()
    expect(screen.getByText('1.2k')).toBeInTheDocument()
  })

  it('asks for the last seven days in the operator calendar, not in UTC', async () => {
    server = stubFetch([route('/api/usage', { status: 200, body: METRICS })])
    renderUsage(<UsageDashboard />)

    await waitFor(() => expect(server.count('/api/usage')).toBe(1))
    const url = new URL(server.last('/api/usage')!.url, 'http://localhost')
    const now = new Date()
    const localDay = (d: Date) =>
      [
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
      ].join('-')

    expect(url.searchParams.get('to')).toBe(localDay(now))
    expect(url.searchParams.get('from')).toBe(localDay(new Date(Date.now() - 7 * 86400000)))
    expect(screen.getByLabelText('From')).toHaveValue(url.searchParams.get('from'))
    expect(screen.getByLabelText('To')).toHaveValue(url.searchParams.get('to'))
  })

  it('re-reads when the range changes', async () => {
    server = stubFetch([route('/api/usage', { status: 200, body: METRICS })])
    renderUsage(<UsageDashboard />)
    await screen.findByText('1.2k')

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } })
    await waitFor(() => expect(server.count('/api/usage')).toBe(2))
    expect(server.last('/api/usage')!.url).toContain('from=2026-10-01')
  })
})

describe('UsageDashboard failure', () => {
  it('names the plane sentence and offers a retry that reads again', async () => {
    server = stubFetch([route('/api/usage', METRICS_UNAVAILABLE)])
    renderUsage(<UsageDashboard />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not read usage.')
    expect(alert.textContent).toContain('Metrics not available')
    expect(alert.textContent).toContain('503')

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(server.count('/api/usage')).toBe(2))
  })

  it('says which port is unreachable when the plane is simply down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
    renderUsage(<UsageDashboard />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('network_unreachable')
    expect(alert.textContent).toContain(':4113')
  })
})

describe('UsageDashboard numbers', () => {
  it('prints every metric once, formatted, with no placeholder for a missing value', async () => {
    server = stubFetch([route('/api/usage', { status: 200, body: METRICS })])
    renderUsage(<UsageDashboard />)

    await screen.findByText('1.2k')
    expect(screen.getByText('5.7k')).toBeInTheDocument()
    expect(screen.getByText('$3.46')).toBeInTheDocument()
    expect(screen.getByText('75.0%')).toBeInTheDocument()
    expect(screen.getByText('50')).toBeInTheDocument()
    expect(screen.getByText('10.0%')).toBeInTheDocument()
    expect(screen.queryByText('--')).toBeNull()
  })

  it('says which ratio could not be computed instead of inventing a zero', async () => {
    server = stubFetch([
      route('/api/usage', {
        status: 200,
        body: {
          ...METRICS,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          toolCallCount: 0,
          toolCallErrors: 0,
        },
      }),
    ])
    renderUsage(<UsageDashboard />)

    await screen.findByText('No cache traffic')
    expect(screen.getByText('No cache traffic')).toBeInTheDocument()
    expect(screen.getByText('No tool calls')).toBeInTheDocument()
    expect(screen.queryByText('0.0%')).toBeNull()
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(2)
  })

  it('publishes the breakdown as a real table with a caption and scoped headers', async () => {
    server = stubFetch([route('/api/usage', { status: 200, body: METRICS })])
    const { container } = renderUsage(<UsageDashboard />)
    await waitFor(() => expect(screen.getByText('Breakdown')).toBeInTheDocument())

    const table = container.querySelector('table')
    expect(table?.querySelector('caption')?.textContent).toContain('to')
    expect([...table!.querySelectorAll('thead th')].map((th) => th.getAttribute('scope'))).toEqual([
      'col',
      'col',
    ])
    expect([...table!.querySelectorAll('tbody th')].map((th) => th.getAttribute('scope'))).toEqual([
      'row',
      'row',
      'row',
    ])
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Usage')
  })
})
