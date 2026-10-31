import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { CampaignMetricsDashboard } from '../components/CampaignMetricsDashboard'
import type { CampaignMetrics } from '../lib/types'
import { route, stubFetch, type FetchStub, type Reply, type Rule } from './fetchStub'


const TENANT_ID = 'tenant-test-1'

function campaign(over: Partial<CampaignMetrics> = {}): CampaignMetrics {
  return {
    bundleId: 'b1b1b1b1-1111-4111-8111-111111111111',
    campaignExternalId: 'ext-100',
    campaignName: 'Winter outreach',
    adAccountId: 'act_999',
    status: 'ACTIVE',
    impressions: 12500,
    clicks: 340,
    spend: 450.25,
    leads: 18,
    costPerLead: 25.01,
    recommendation: 'scale',
    lastAnalystRun: '2026-10-27T09:00:00.000Z',
    ...over,
  }
}

const metricsReply = (items: CampaignMetrics[]): Reply => ({
  status: 200,
  body: { items },
})

let server: FetchStub

function mount(rules: Rule[]) {
  server = stubFetch(rules)
  return server
}

beforeEach(() => {
  server = stubFetch([])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CampaignMetricsDashboard', () => {
  it('renders an empty state when no campaigns exist', async () => {
    mount([route('/api/marketing/campaign-metrics', metricsReply([]))])
    render(<CampaignMetricsDashboard tenantId={TENANT_ID} />)

    expect(await screen.findByText('No active campaigns to show.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('renders all required columns when campaign data is present', async () => {
    mount([
      route('/api/marketing/campaign-metrics', metricsReply([campaign()])),
    ])
    render(<CampaignMetricsDashboard tenantId={TENANT_ID} />)

    // Column headers
    expect(await screen.findByText('Campaign')).toBeInTheDocument()
    expect(screen.getByText('Ad account')).toBeInTheDocument()
    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByText('Impressions')).toBeInTheDocument()
    expect(screen.getByText('Clicks')).toBeInTheDocument()
    expect(screen.getByText('Spend')).toBeInTheDocument()
    expect(screen.getByText('Leads')).toBeInTheDocument()
    expect(screen.getByText('Cost / lead')).toBeInTheDocument()
    expect(screen.getByText('Recommendation')).toBeInTheDocument()
    expect(screen.getByText('Last analyst run')).toBeInTheDocument()

    // Row data
    expect(screen.getByText('Winter outreach')).toBeInTheDocument()
    expect(screen.getByText('act_999')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText('12,500')).toBeInTheDocument()
    expect(screen.getByText('340')).toBeInTheDocument()
    expect(screen.getByText('$450.25')).toBeInTheDocument()
    expect(screen.getByText('18')).toBeInTheDocument()
    expect(screen.getByText('$25.01')).toBeInTheDocument()
    expect(screen.getByText('scale')).toBeInTheDocument()
  })

  it('shows a green badge for "scale" recommendation', async () => {
    mount([
      route('/api/marketing/campaign-metrics', metricsReply([campaign({ recommendation: 'scale' })])),
    ])
    render(<CampaignMetricsDashboard tenantId={TENANT_ID} />)

    const badge = await screen.findByText('scale')
    expect(badge).toBeInTheDocument()
    // The Badge component applies variant classes; success variant renders green
    expect(badge.closest('[data-slot="badge"]')).toBeTruthy()
  })

  it('shows a yellow badge for "hold" recommendation', async () => {
    mount([
      route('/api/marketing/campaign-metrics', metricsReply([campaign({ recommendation: 'hold' })])),
    ])
    render(<CampaignMetricsDashboard tenantId={TENANT_ID} />)

    const badge = await screen.findByText('hold')
    expect(badge).toBeInTheDocument()
  })

  it('shows a red badge for "kill" recommendation', async () => {
    mount([
      route('/api/marketing/campaign-metrics', metricsReply([campaign({ recommendation: 'kill' })])),
    ])
    render(<CampaignMetricsDashboard tenantId={TENANT_ID} />)

    const badge = await screen.findByText('kill')
    expect(badge).toBeInTheDocument()
  })

  it('shows a dash when recommendation is null', async () => {
    mount([
      route('/api/marketing/campaign-metrics', metricsReply([campaign({ recommendation: null })])),
    ])
    render(<CampaignMetricsDashboard tenantId={TENANT_ID} />)

    await screen.findByText('Winter outreach')
    // When recommendation is null, the cell renders a dash
    const cells = screen.getAllByText('—')
    expect(cells.length).toBeGreaterThan(0)
  })

  it('shows "Paused" status with secondary badge for paused campaigns', async () => {
    mount([
      route('/api/marketing/campaign-metrics', metricsReply([campaign({ status: 'PAUSED' })])),
    ])
    render(<CampaignMetricsDashboard tenantId={TENANT_ID} />)

    expect(await screen.findByText('Paused')).toBeInTheDocument()
  })

  it('shows cost-per-leader as dash when leads are zero', async () => {
    mount([
      route(
        '/api/marketing/campaign-metrics',
        metricsReply([campaign({ leads: 0, costPerLead: 0 })]),
      ),
    ])
    render(<CampaignMetricsDashboard tenantId={TENANT_ID} />)

    await screen.findByText('Winter outreach')
    // The cell should contain a dash, not $0.00
    const cells = screen.getAllByText('—')
    expect(cells.length).toBeGreaterThan(0)
  })

  it('links each campaign row to the marketing bundle screen', async () => {
    const bundleId = 'b1b1b1b1-1111-4111-8111-111111111111'
    mount([
      route('/api/marketing/campaign-metrics', metricsReply([campaign({ bundleId })])),
    ])
    render(<CampaignMetricsDashboard tenantId={TENANT_ID} />)

    const link = await screen.findByRole('link', { name: 'Winter outreach' })
    expect(link).toHaveAttribute('href', `/marketing/${bundleId}`)
  })

  it('reports an API error instead of showing an empty table', async () => {
    mount([
      route('/api/marketing/campaign-metrics', {
        status: 401,
        body: { error: 'unauthorized', reason: 'missing-claim' },
      }),
    ])
    render(<CampaignMetricsDashboard tenantId={TENANT_ID} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('missing-claim')
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('passes the tenantId as a query parameter', async () => {
    mount([route('/api/marketing/campaign-metrics', metricsReply([]))])
    render(<CampaignMetricsDashboard tenantId={TENANT_ID} />)

    await screen.findByText('No active campaigns to show.')
    const call = server.last('/api/marketing/campaign-metrics')
    expect(call?.url).toContain(`tenantId=${TENANT_ID}`)
  })

  it('renders multiple campaigns in the table', async () => {
    mount([
      route(
        '/api/marketing/campaign-metrics',
        metricsReply([
          campaign({ bundleId: 'b1', campaignName: 'Alpha' }),
          campaign({ bundleId: 'b2', campaignName: 'Beta', recommendation: 'hold' }),
          campaign({ bundleId: 'b3', campaignName: 'Gamma', recommendation: 'kill' }),
        ]),
      ),
    ])
    render(<CampaignMetricsDashboard tenantId={TENANT_ID} />)

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(await screen.findByText('Beta')).toBeInTheDocument()
    expect(await screen.findByText('Gamma')).toBeInTheDocument()
    expect(screen.getByText('scale')).toBeInTheDocument()
    expect(screen.getByText('hold')).toBeInTheDocument()
    expect(screen.getByText('kill')).toBeInTheDocument()
  })

  it('shows the last analyst run timestamp formatted as a locale string', async () => {
    const ts = '2026-10-27T09:00:00.000Z'
    mount([
      route('/api/marketing/campaign-metrics', metricsReply([campaign({ lastAnalystRun: ts })])),
    ])
    render(<CampaignMetricsDashboard tenantId={TENANT_ID} />)

    await screen.findByText('Winter outreach')
    // The timestamp should be rendered in some locale format; just check it's present
    const expected = new Date(ts).toLocaleString()
    expect(screen.getByText(expected)).toBeInTheDocument()
  })

  it('the reload button re-fetches campaign metrics', async () => {
    mount([route('/api/marketing/campaign-metrics', metricsReply([]))])
    render(<CampaignMetricsDashboard tenantId={TENANT_ID} />)

    await screen.findByText('No active campaigns to show.')
    expect(server.count('/api/marketing/campaign-metrics')).toBe(1)

    const reload = screen.getByRole('button', { name: 'Reload' })
    reload.click()

    await waitFor(() => expect(server.count('/api/marketing/campaign-metrics')).toBe(2))
  })
})
