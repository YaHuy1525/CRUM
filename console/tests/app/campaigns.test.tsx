import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { route, stubFetch, type FetchStub } from '../fetchStub'


const TENANT_ID = '11111111-1111-4111-8111-111111111111'

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
  vi.resetModules()
})

afterEach(() => {
  client?.clear()
  vi.unstubAllGlobals()
  delete process.env.CRUM_DEV_TENANT_ID
})

describe('CampaignsPage', () => {
  it('renders without errors when tenantId is configured', async () => {
    process.env.CRUM_DEV_TENANT_ID = TENANT_ID
    server = stubFetch([
      route('/api/marketing/campaign-metrics', { status: 200, body: { items: [] } }),
    ])

    const { default: CampaignsPage } = await import('@/app/campaigns/page')
    mount(<CampaignsPage />)

    expect(await screen.findByText('Campaign metrics')).toBeInTheDocument()
  })

  it('passes the tenantId to the dashboard component', async () => {
    process.env.CRUM_DEV_TENANT_ID = TENANT_ID
    server = stubFetch([
      route('/api/marketing/campaign-metrics', { status: 200, body: { items: [] } }),
    ])

    const { default: CampaignsPage } = await import('@/app/campaigns/page')
    mount(<CampaignsPage />)

    await screen.findByText('Campaign metrics')
    const call = server.last('/api/marketing/campaign-metrics')
    expect(call?.url).toContain(`tenantId=${TENANT_ID}`)
  })

  it('shows a configuration message when tenantId is missing', async () => {
    delete process.env.CRUM_DEV_TENANT_ID

    const { default: CampaignsPage } = await import('@/app/campaigns/page')
    mount(<CampaignsPage />)

    expect(
      await screen.findByText(/No tenant configured/),
    ).toBeInTheDocument()
  })
})
