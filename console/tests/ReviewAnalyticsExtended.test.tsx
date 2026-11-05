import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReviewAnalytics } from '../components/ReviewAnalytics'
import type { ReviewAnalytics as Analytics } from '../lib/review'
import { route, stubFetch } from './fetchStub'

const MOCK_DATA: Analytics = {
  window: { from: '2026-01-01', to: '2026-12-31', days: 365 },
  byRule: [],
  topFields: [],
  bySource: [],
  correctionRate: { corrected: 0, documents: 0, rate: null },
  turnaround: { p50Hours: null, p90Hours: null },
  confidenceTrend: [],
  byCustomer: [
    { customer: 'Acme Corp', documents: 10, documentsWithFindings: 8, totalFindings: 15 },
    { customer: 'Globex', documents: 5, documentsWithFindings: 3, totalFindings: 7 },
  ],
  byVendor: [
    { vendor: 'Vendor A', documents: 8, documentsWithFindings: 6, totalFindings: 12 },
  ],
  heatmap: [
    { kind: 'invoice', field: 'total_amount', corrections: 10 },
    { kind: 'invoice', field: 'vendor_name', corrections: 5 },
    { kind: 'contract', field: 'total_amount', corrections: 3 },
  ],
}

describe('ReviewAnalytics extended tables', () => {
  beforeEach(() => {
    stubFetch([
      route('/api/documents/analytics/review', {
        status: 200,
        body: MOCK_DATA,
      }, 'GET'),
    ])
  })

  it('renders By customer table', async () => {
    render(<ReviewAnalytics kind={null} />)
    expect(await screen.findByText('By customer')).toBeTruthy()
    expect(screen.getByText('Acme Corp')).toBeTruthy()
    expect(screen.getByText('Globex')).toBeTruthy()
  })

  it('renders By vendor table', async () => {
    render(<ReviewAnalytics kind="invoice" />)
    expect(await screen.findByText('By vendor')).toBeTruthy()
    expect(screen.getByText('Vendor A')).toBeTruthy()
  })

  it('renders No data when arrays are empty', async () => {
    const emptyData = { ...MOCK_DATA, byCustomer: [], byVendor: [] }
    stubFetch([
      route('/api/documents/analytics/review', {
        status: 200,
        body: emptyData,
      }, 'GET'),
    ])
    render(<ReviewAnalytics kind={null} />)
    const noDataElements = await screen.findAllByText('No data')
    expect(noDataElements.length).toBeGreaterThanOrEqual(2)
  })

  it('renders heatmap grid with color-coded cells', async () => {
    render(<ReviewAnalytics kind={null} />)
    expect(await screen.findByText('Field correction heatmap')).toBeTruthy()
    const cells = screen.getAllByTestId('heatmap-cell')
    expect(cells.length).toBe(3)
  })
})
