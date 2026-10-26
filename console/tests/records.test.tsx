import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

import { RecordsBrowser } from '@/components/records/RecordsBrowser'
import type { CrmListResponse, CustomerRow } from '@/lib/types'
import { route, stubFetch, type FetchStub } from './fetchStub'

function customer(over: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: 'c1c1c1c1-1111-4111-8111-111111111111',
    tenant_id: 't1',
    name: 'Nordwind Freight',
    city: 'Hamburg',
    tags: ['enterprise'],
    owner_id: 'u1',
    team_member_ids: [],
    created_at: '2026-10-01T09:00:00.000Z',
    updated_at: '2026-10-01T09:00:00.000Z',
    ...over,
  }
}

function page<T>(items: T[], over: Partial<CrmListResponse<T>> = {}): CrmListResponse<T> {
  return { items, total: items.length, limit: 25, offset: 0, hasMore: false, ...over }
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

describe('RecordsBrowser', () => {
  it('reads customers first and links each row to its detail route', async () => {
    server = stubFetch([route('/api/crm/customers', { status: 200, body: page([customer()]) })])
    mount(<RecordsBrowser />)

    const link = await screen.findByRole('link', { name: 'Nordwind Freight' })
    expect(link).toHaveAttribute('href', '/records/customers/c1c1c1c1-1111-4111-8111-111111111111')
    expect(screen.getByText('Showing 1 of 1 customers')).toBeInTheDocument()

    const call = server.last('/api/crm/customers')
    expect(call?.url).toContain('limit=25')
    expect(call?.url).toContain('offset=0')
    expect(call?.url).not.toContain('name=')
  })

  it('Load more asks for the next offset and appends the rows', async () => {
    server = stubFetch([
      route('/api/crm/customers', (call) =>
        call.url.includes('offset=1')
          ? { status: 200, body: page([customer({ id: 'c2', name: 'Alpen Logistics' })], { total: 2, offset: 1 }) }
          : { status: 200, body: page([customer()], { total: 2, hasMore: true }) },
      ),
    ])
    mount(<RecordsBrowser />)

    await screen.findByRole('link', { name: 'Nordwind Freight' })
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByRole('link', { name: 'Alpen Logistics' })).toBeInTheDocument()
    expect(screen.getByText('Showing 2 of 2 customers')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Nordwind Freight' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('debounces the name filter into the query string', async () => {
    server = stubFetch([
      route('/api/crm/customers', { status: 200, body: page([customer({ name: 'Nordwind Freight' })]) }),
    ])
    mount(<RecordsBrowser />)

    await screen.findByRole('link', { name: 'Nordwind Freight' })
    fireEvent.change(screen.getByLabelText('Filter by name'), { target: { value: 'Nord' } })

    await waitFor(() => expect(server.last('/api/crm/customers')?.url).toContain('name=Nord'), {
      timeout: 2000,
    })
  })

  it('switching tabs reads the other endpoint and clears the filter', async () => {
    server = stubFetch([
      route('/api/crm/customers', { status: 200, body: page([customer()]) }),
      route('/api/crm/tasks', { status: 200, body: page([]) }),
    ])
    mount(<RecordsBrowser />)

    await screen.findByRole('link', { name: 'Nordwind Freight' })
    fireEvent.change(screen.getByLabelText('Filter by name'), { target: { value: 'Nord' } })
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Tasks' }))

    expect(await screen.findByText(/No tasks yet/)).toBeInTheDocument()
    expect(screen.getByText(/Listed tenant-wide/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Filter by name')).toBeNull()
    expect(server.last('/api/crm/tasks')?.url).not.toContain('name=')
  })

  it('reports a failed read and reads again on retry', async () => {
    server = stubFetch([
      route('/api/crm/customers', {
        status: 503,
        body: { error: 'unavailable', detail: 'query plane down' },
      }),
    ])
    mount(<RecordsBrowser />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('query plane down')

    const before = server.count('/api/crm/customers')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(server.count('/api/crm/customers')).toBeGreaterThan(before))
  })
})
