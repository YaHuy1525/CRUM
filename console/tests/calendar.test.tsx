import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CalendarPage from '../app/calendar/page'
import { layoutDay, mondayOf, ymd } from '../components/CalendarBoard'
import { route, stubFetch, type FetchStub, type Rule } from './fetchStub'


const anchor = mondayOf(new Date())
const day = (n: number, h: number, min = 0): string => {
  const d = new Date(anchor)
  d.setDate(d.getDate() + n)
  d.setHours(h, min, 0, 0)
  return d.toISOString()
}

const meeting = (over: Partial<Record<string, unknown>> & { id: string; start: string }) => ({
  tenant_id: 't',
  customer_id: 'cust-1',
  title: 'Quarterly review',
  end_time: null,
  location: 'Teams',
  status: 'confirmed',
  attendees: ['Ana Prime'],
  customer_name: 'Ariel Tan',
  customer_company: 'Meridian Freight',
  owner_id: 'own-1',
  created_at: day(0, 0),
  updated_at: day(0, 0),
  ...over,
  start_time: over.start,
})

function listBody(items: unknown[]) {
  return { items, total: items.length, limit: 100, offset: 0, hasMore: false }
}

let server: FetchStub
function mountWith(rules: Rule[]) {
  server = stubFetch(rules)
  return render(<CalendarPage />)
}

const schedulesRoute = (items: unknown[]): Rule =>
  route('/api/crm/schedules', { status: 200, body: listBody(items) }, 'GET')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('layoutDay overlap lanes', () => {
  it('splits two colliding meetings into side-by-side lanes of one cluster', () => {
    const placed = layoutDay([
      meeting({ id: 'a', start: day(2, 9), end_time: day(2, 10) }) as never,
      meeting({ id: 'b', start: day(2, 9, 30), end_time: day(2, 10, 30) }) as never,
    ] as never)
    expect(placed.map((p) => p.lane)).toEqual([0, 1])
    expect(placed.every((p) => p.lanes === 2)).toBe(true)
  })

  it('gives non-overlapping meetings the full width', () => {
    const placed = layoutDay([
      meeting({ id: 'a', start: day(2, 9), end_time: day(2, 10) }) as never,
      meeting({ id: 'b', start: day(2, 11), end_time: day(2, 12) }) as never,
    ] as never)
    expect(placed.map((p) => p.lane)).toEqual([0, 0])
    expect(placed.every((p) => p.lanes === 1)).toBe(true)
  })
})

describe('CalendarBoard week fetching', () => {
  it('asks for the visible week plus one spare day either side', async () => {
    mountWith([schedulesRoute([meeting({ id: 'e1', start: day(2, 9) })])])
    await waitFor(() => expect(server.last('/api/crm/schedules')).toBeDefined())
    const url = server.last('/api/crm/schedules')!.url
    const spareBefore = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - 1)
    const spareAfter = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 7)
    expect(url).toContain(`from=${ymd(spareBefore)}`)
    expect(url).toContain(`to=${ymd(spareAfter)}`)
    expect(url).toContain('limit=100')
  })

  it('drops an out-of-week row the spare-day range let through', async () => {
    const stray = new Date(anchor)
    stray.setDate(stray.getDate() - 1)
    mountWith([schedulesRoute([meeting({ id: 'stray', start: stray.toISOString() })])])
    await waitFor(() => expect(server.last('/api/crm/schedules')).toBeDefined())
    expect(screen.queryByTestId('event-stray')).not.toBeInTheDocument()
  })

  it('shifts the whole week by exactly seven days on Next week', async () => {
    const user = userEvent.setup()
    mountWith([schedulesRoute([])])
    await waitFor(() => expect(server.last('/api/crm/schedules')).toBeDefined())
    await user.click(screen.getByRole('button', { name: 'Next week' }))
    await waitFor(() => expect(server.count('/api/crm/schedules')).toBe(2))
    const next = server.last('/api/crm/schedules')!.url
    expect(next).toContain(`from=${ymd(new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 6))}`)
    expect(next).toContain(`to=${ymd(new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 14))}`)
  })
})

describe('CalendarBoard rendering', () => {
  it('renders meeting titles and customer names on the grid', async () => {
    mountWith([schedulesRoute([meeting({ id: 'e1', start: day(2, 9), end_time: day(2, 10) })])])
    expect(await screen.findByTestId('event-e1')).toBeInTheDocument()
    expect(screen.getByTestId('event-e1')).toHaveTextContent('Quarterly review')
    expect(screen.getByTestId('event-e1')).toHaveTextContent('Meridian Freight')
  })

  it('opens the detail dialog with the customer link', async () => {
    const user = userEvent.setup()
    mountWith([schedulesRoute([meeting({ id: 'e2', start: day(1, 10), end_time: day(1, 11) })])])
    await user.click(await screen.findByTestId('event-e2'))
    const link = await screen.findByRole('link', { name: /Meridian Freight/ })
    expect(link).toHaveAttribute('href', '/customer/cust-1')
  })

  it('shows the plane failure verbatim rather than an empty week', async () => {
    mountWith([
      route('/api/crm/schedules', { status: 401, body: { error: 'unauthorized', reason: 'missing-claim' } }, 'GET'),
    ])
    expect(await screen.findByRole('alert')).toHaveTextContent(/unauthorized/)
  })

  it('names the seed script when the week is genuinely empty', async () => {
    mountWith([schedulesRoute([])])
    expect(await screen.findByText(/Nothing scheduled this week/)).toBeInTheDocument()
    expect(screen.getByText(/cal:seed/)).toBeInTheDocument()
  })
})
