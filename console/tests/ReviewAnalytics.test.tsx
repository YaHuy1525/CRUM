import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReviewAnalytics } from '../components/ReviewAnalytics'
import { route, stubFetch, type FetchStub } from './fetchStub'

const DATA = {
  window: { from: '2026-08-05', to: '2026-11-03', days: 90 },
  byRule: [
    { ruleId: 'invoice.total.sum', total: 12, open: 5, waived: 7 },
    { ruleId: 'invoice.currency.shape', total: 3, open: 3, waived: 0 },
  ],
  topFields: [{ field: 'total', corrections: 9, violations: 12 }],
  bySource: [{ changeSource: 'manual_correction', count: 20 }],
  correctionRate: { corrected: 4, documents: 10, rate: 0.4 },
  turnaround: { p50Hours: 3, p90Hours: 7.6 },
  confidenceTrend: [{ week: '2026-09-21', avgConfidence: 0.81, correctionRate: 0.5 }],
}

let server: FetchStub

beforeEach(() => {
  server = stubFetch([route('/api/documents/analytics/review', { status: 200, body: DATA }, 'GET')])
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() }))
})

describe('ReviewAnalytics', () => {
  it('fetches on mount and names the window it used', async () => {
    render(<ReviewAnalytics kind={null} />)
    await waitFor(() => expect(server.count('analytics/review')).toBe(1))
    expect(await screen.findByText(/2026-08-05/)).toBeInTheDocument()
  })

  it('lists rules by volume with the open and waived counts beside them', async () => {
    render(<ReviewAnalytics kind={null} />)
    await screen.findByText('invoice.total.sum')
    expect(screen.getByText('invoice.total.sum').closest('tr')).toHaveTextContent('12')
    expect(screen.getByText('invoice.total.sum').closest('tr')).toHaveTextContent('waived 7')
  })

  it('draws a bar whose width is relative to the largest rule', async () => {
    render(<ReviewAnalytics kind={null} />)
    const bars = await screen.findAllByTestId('bar')
    expect(bars[0]).toHaveStyle({ width: '100%' })
    expect(bars[1]).toHaveStyle({ width: '25%' })
  })

  it('prints the correction rate as a fraction before it prints a percentage', async () => {
    render(<ReviewAnalytics kind={null} />)
    expect(await screen.findByText(/4 of 10 corrected/)).toBeInTheDocument()
    expect(screen.getByText(/40[.]0%/)).toBeInTheDocument()
  })

  it('shows a null rate as no data, not as zero', async () => {
    server = stubFetch([route('/api/documents/analytics/review', {
      status: 200, body: { ...DATA, correctionRate: { corrected: 0, documents: 0, rate: null }, turnaround: { p50Hours: null, p90Hours: null } },
    }, 'GET')])
    render(<ReviewAnalytics kind={null} />)
    expect(await screen.findByText(/no corrections yet/i)).toBeInTheDocument()
  })

  it('renders turnaround in hours with one decimal', async () => {
    render(<ReviewAnalytics kind={null} />)
    expect(await screen.findByText(/3[.]0 h/)).toBeInTheDocument()
    expect(screen.getByText(/7[.]6 h/)).toBeInTheDocument()
  })

  it('passes the kind filter through to the query string', async () => {
    render(<ReviewAnalytics kind="contract" />)
    await waitFor(() => expect(server.last('analytics/review')?.url).toContain('kind=contract'))
  })

  it('exports by requesting the csv route for the same window', async () => {
    const clicked = vi.fn()
    const anchor = document.createElement('a')
    anchor.click = clicked
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
      tag === 'a' ? Object.assign(realCreate('a'), { click: clicked }) : realCreate(tag as never),
    )
    server = stubFetch([
      route('/api/documents/analytics/review', { status: 200, body: DATA }, 'GET'),
      route('/api/documents/audit/export', { status: 200, body: 'document_id,reason' }, 'GET'),
    ])
    render(<ReviewAnalytics kind={null} />)
    await screen.findByText('invoice.total.sum')
    await userEvent.clear(screen.getByRole('textbox', { name: /from/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /from/i }), '2026-10-01')
    await userEvent.click(screen.getByRole('button', { name: /export csv/i }))
    await waitFor(() => expect(server.count('audit/export')).toBe(1))
    await waitFor(() => expect(clicked).toHaveBeenCalledTimes(1))
    expect(String(server.last('audit/export')?.url)).toContain('from=2026-10-01')
  })

  it('reports a too-many-rows refusal instead of downloading nothing quietly', async () => {
    server = stubFetch([
      route('/api/documents/analytics/review', { status: 200, body: DATA }, 'GET'),
      route('/api/documents/audit/export', { status: 400, body: { error: 'too_many_rows', max: 50000 } }, 'GET'),
    ])
    render(<ReviewAnalytics kind={null} />)
    await screen.findByText('invoice.total.sum')
    await userEvent.click(screen.getByRole('button', { name: /export csv/i }))
    expect(await screen.findByText(/too many rows/i)).toBeInTheDocument()
  })

  it('accepts a narrower window from the form', async () => {
    render(<ReviewAnalytics kind={null} />)
    await screen.findByText('invoice.total.sum')
    await userEvent.clear(screen.getByRole('textbox', { name: /from/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /from/i }), '2026-10-01')
    await userEvent.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() => expect(server.last('analytics/review')?.url).toContain('from=2026-10-01'))
  })
})
